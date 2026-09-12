// Fractalize Core: the WebGL fractal viewer ("Fractalize Studio"), the
// "visualize to music" noise-warp view, and the live-audio input plumbing
// they share. Extracted from gallery.js so this file can move into its own
// repo (fractalize-core, included as a git submodule) and be reused by both
// tuckermills.com's embedded instance and the standalone fractalize.studio
// site. A host page talks to this file ONLY through window.FractalizeCore
// (see the bottom of this file) -- everything else here is closure-private.
//
// Host contract: call window.FractalizeCore.setPhotoCatalog(groups) once
// with the photos the camera-roll panel should browse
// ([{label, photos:[{src, thumbSrc}]}]), then openFractal(srcOrImgEl)/
// openVisualizer(srcOrImgEl) with either an already-loaded <img> element or
// a plain src string (this file loads/decodes it before using it either
// way). No other page-global state (no gallery grid, no lightbox, no
// music-player object) is read by anything in this file.
(function () {
  // "Visualize to music": a fullscreen, cover-fit view of a photo, warped
  // in time with the music. There's no way to read the actual audio
  // playing in Bandcamp's cross-origin iframe -- no exposed API, and Web
  // Audio can't analyze a media element outside its own document -- so the
  // warp is driven entirely by opt-in live audio input (see
  // enableLiveAudio/computePulse below): a visitor with a loopback/
  // virtual-cable device selected can feed their actual system/Bandcamp
  // playback audio in, same as the fractal. No live audio means no
  // reactivity -- both views sit inert/idle rather than fake a reaction to
  // audio that was never actually heard. The warp itself is a native SVG
  // filter (feTurbulence + feDisplacementMap), animated by rewriting its
  // scale each frame -- no canvas, no libraries.
  let visualizerEl = null;
  let visualizerImgEl = null;
  let visualizerDisplacementEl = null;
  let visualizerTurbulenceEl = null;
  let visualizerRAF = null;
  // The visualizer's own tiny persisted settings -- separate from
  // fractalSettings/FRACTAL_SETTINGS_KEY below since that object is only
  // ever loaded when the fractal itself is opened at least once
  // (buildFractal's own loadFractalSettings() call), and the visualizer
  // needs to work standalone without assuming the fractal was ever
  // touched. bumpZoomEnabled: whether the live-audio pulse drives the
  // warp's displacement/zoom-scale/brightness at all (see
  // VISUALIZER_DEFAULTS' own comment on why this needed to be a real
  // setting) -- on by default, matching original behavior.
  let visualizerSettings = null;
  const VISUALIZER_DEFAULTS = { bumpZoomEnabled: true };
  const VISUALIZER_SETTINGS_KEY = "tuckerMillsVisualizerSettings";
  function loadVisualizerSettings() {
    try {
      const raw = localStorage.getItem(VISUALIZER_SETTINGS_KEY);
      return Object.assign({}, VISUALIZER_DEFAULTS, raw ? JSON.parse(raw) : {});
    } catch (e) {
      return Object.assign({}, VISUALIZER_DEFAULTS);
    }
  }
  function saveVisualizerSettings(settings) {
    try {
      localStorage.setItem(VISUALIZER_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      // Private browsing / storage disabled -- setting just won't persist.
    }
  }
  // How long one "descend into finer fractal detail, then reset" cycle
  // takes -- independent of and layered on top of the audio-driven pulse
  // below, so the two rhythms don't lock to each other. Runs regardless
  // of whether live audio is active, so the view is never fully static.
  const FRACTAL_CYCLE_MS = 10000;

  // The sole source of computePulse's reactivity below -- opt-in only,
  // via a "Live audio input" checkbox (see wireLiveAudioControls, shared
  // by both the fractal's and the noise-warp visualizer's settings
  // panels), since it needs microphone permission. The ON/OFF state
  // itself is deliberately NOT persisted: this always starts back at
  // "off" on every fresh open of either view, never a silent re-prompt.
  // The chosen INPUT DEVICE is persisted (LIVE_AUDIO_DEVICE_KEY below),
  // so checking the box again later defaults to whichever device was
  // picked last time instead of the browser's default -- a separate,
  // harmless concern from auto-enabling, since it still requires an
  // explicit click to actually request the microphone. A visitor with a
  // loopback/virtual-cable input device
  // selected (Stereo Mix, VB-Cable, BlackHole, etc.) can feed their
  // actual system/Bandcamp playback audio in this way -- the browser has
  // no way to tell "real microphone" apart from "virtual cable
  // pretending to be one," so this works with headphones plugged in
  // without ever touching Bandcamp's stream directly. There is
  // deliberately no other source of reactivity (no precomputed waveform,
  // no BPM-timed guess) -- both visualizers sit inert/idle rather than
  // fake a reaction to audio that was never actually heard.
  let liveAudioContext = null;
  let liveAudioAnalyser = null;
  let liveAudioDataArray = null;
  let liveAudioStream = null;

  // Off by default -- closeFractal/closeVisualizer both stop the shared
  // stream on their way out specifically so no stray mic indicator
  // lingers once a visitor leaves (see disableLiveAudio's own comment),
  // which is the right call for a one-shot embedded view. A host page
  // whose OWN flow keeps live audio as page-level, persistent state
  // (fractalize-studio's -- its own "Live Audio In Use" button/banner
  // reflect this same shared stream independent of either overlay being
  // open) opts out via setKeepLiveAudioOnClose below, since a visitor
  // there is far more likely to close one photo's fractal only to
  // immediately reopen a different one. tuckermills.com never calls
  // that setter, so this stays false there and closing keeps stopping
  // the stream exactly as before.
  let keepLiveAudioOnClose = false;

  const LIVE_AUDIO_DEVICE_KEY = "tuckerMillsLiveAudioDeviceId";

  function loadPreferredAudioDeviceId() {
    try {
      return localStorage.getItem(LIVE_AUDIO_DEVICE_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  function savePreferredAudioDeviceId(deviceId) {
    try {
      if (deviceId) localStorage.setItem(LIVE_AUDIO_DEVICE_KEY, deviceId);
    } catch (e) {
      // Private browsing / storage disabled -- selection just won't persist.
    }
  }

  function readLiveAudioPulse() {
    if (!liveAudioAnalyser) return null;
    liveAudioAnalyser.getByteFrequencyData(liveAudioDataArray);
    let sum = 0;
    for (let i = 0; i < liveAudioDataArray.length; i++) sum += liveAudioDataArray[i];
    return sum / liveAudioDataArray.length / 255;
  }

  function stopLiveAudioStream() {
    if (liveAudioStream) liveAudioStream.getTracks().forEach((t) => t.stop());
    liveAudioStream = null;
  }

  // Only tears down the *previous* stream once the new one is confirmed
  // working (stream is fetched before stopLiveAudioStream runs) -- so a
  // failed device switch (unplugged/removed device) leaves whatever was
  // already working untouched instead of going silent.
  async function enableLiveAudio(deviceId, onDisconnect) {
    const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stopLiveAudioStream();
    if (!liveAudioContext) liveAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (liveAudioContext.state === "suspended") await liveAudioContext.resume();
    const source = liveAudioContext.createMediaStreamSource(stream);
    const analyser = liveAudioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    liveAudioStream = stream;
    liveAudioAnalyser = analyser;
    liveAudioDataArray = new Uint8Array(analyser.frequencyBinCount);
    stream.getAudioTracks()[0].addEventListener("ended", () => {
      // Device unplugged/removed mid-session -- only react if a newer
      // enableLiveAudio call hasn't already replaced this stream.
      if (liveAudioStream !== stream) return;
      liveAudioAnalyser = null;
      liveAudioDataArray = null;
      liveAudioStream = null;
      if (onDisconnect) onDisconnect();
    });
    return stream;
  }

  // Tries the given device first; a deviceId left over from a previous
  // visit can go stale (unplugged, renamed) and getUserMedia rejects
  // that specific case with OverconstrainedError -- fall back to the
  // browser's default device instead of surfacing an error for what's
  // really just a stale preference.
  async function enableLiveAudioWithFallback(deviceId, onDisconnect) {
    try {
      return await enableLiveAudio(deviceId, onDisconnect);
    } catch (err) {
      if (deviceId && err && err.name === "OverconstrainedError") {
        return enableLiveAudio(null, onDisconnect);
      }
      throw err;
    }
  }

  // Resets every "Live audio input" control currently on the page, not
  // just whichever one triggered the stop -- there can be up to three at
  // once (the fractal panel, the visualizer panel, and a host page's own
  // copy, see wireLiveAudioControls below), all sharing this one
  // microphone stream, so closing one or a host page's own toggle must
  // leave the other two agreeing it's off rather than showing a stale
  // "on" state for a stream that no longer exists. Each control's
  // toggle/device-row/status live inside a shared [data-live-audio-panel]
  // wrapper (see the markup in buildFractal/buildVisualizer and a host
  // page's own, e.g. fractalize-studio's), found generically here rather
  // than passed in, so this needs no awareness of how many panels exist
  // or where.
  function disableLiveAudio() {
    stopLiveAudioStream();
    liveAudioAnalyser = null;
    liveAudioDataArray = null;
    document.querySelectorAll("[data-live-audio-panel]").forEach((panel) => {
      const toggle = panel.querySelector('[data-toggle="liveAudio"]');
      if (toggle) toggle.checked = false;
      const row = panel.querySelector(".fractal-controls-audio-device");
      if (row) row.hidden = true;
      const status = panel.querySelector("[data-audio-status]");
      if (status) status.textContent = "";
      // See wireLiveAudioControls' own comment on this event -- lets a
      // host page react to the live-audio state going off from HERE
      // (closing the fractal, another panel's own toggle, ...), not
      // just from its own panel's checkbox changing.
      panel.dispatchEvent(new CustomEvent("liveaudiostatechange", { detail: { active: false } }));
    });
    stopWaveformLoop();
  }

  // A small live oscilloscope trace next to the device picker (see the
  // markup in buildFractal/buildVisualizer/wireLiveAudioControls) -- the
  // simplest "yes, audio is actually being detected" feedback for a
  // control that otherwise just says "Listening" with no way to confirm
  // that's true before opening a fractal/visualizer. One shared
  // requestAnimationFrame loop draws the SAME waveform onto every
  // [data-audio-waveform] canvas currently on the page (there can be up
  // to three, same as the panels themselves) rather than one loop per
  // panel, since they're all reading the same analyser anyway. Started
  // on a successful enable/device-switch below; stopped and cleared
  // from disableLiveAudio() above so it never outlives the stream.
  let waveformRAF = null;
  let waveformTimeDomain = null;
  function drawWaveforms() {
    if (!liveAudioAnalyser) {
      waveformRAF = null;
      return;
    }
    if (!waveformTimeDomain || waveformTimeDomain.length !== liveAudioAnalyser.fftSize) {
      waveformTimeDomain = new Uint8Array(liveAudioAnalyser.fftSize);
    }
    liveAudioAnalyser.getByteTimeDomainData(waveformTimeDomain);
    document.querySelectorAll("[data-audio-waveform]").forEach((canvas) => {
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      const step = w / waveformTimeDomain.length;
      for (let i = 0; i < waveformTimeDomain.length; i++) {
        // 0-255 centered on 128 (silence) -> -1..1
        const v = waveformTimeDomain[i] / 128 - 1;
        const x = i * step;
        const y = h / 2 + v * (h / 2 - 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    waveformRAF = requestAnimationFrame(drawWaveforms);
  }
  function startWaveformLoop() {
    if (!waveformRAF) waveformRAF = requestAnimationFrame(drawWaveforms);
  }
  function stopWaveformLoop() {
    if (waveformRAF) cancelAnimationFrame(waveformRAF);
    waveformRAF = null;
    document.querySelectorAll("[data-audio-waveform]").forEach((canvas) => {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    });
  }

  // Wires a "Live audio input" checkbox + device <select> + status text
  // inside `panel` (expects the same four data-hooks buildFractal's own
  // markup uses: [data-toggle="liveAudio"], .fractal-controls-audio-
  // device, [data-audio-device], [data-audio-status]) to enableLiveAudio/
  // disableLiveAudio above. Shared between the fractal's settings panel
  // and the noise-warp visualizer's own -- this is the only source of
  // reactivity for either view now (see the comment above
  // liveAudioContext), so both need it, and writing/fixing this device-
  // enumeration/disconnect/mid-session-switch logic in one place beats
  // maintaining two copies. The checkbox itself is deliberately kept out
  // of fractalSettings/localStorage (same comment) -- always starts
  // unchecked, in either panel, on every fresh open -- but the picked
  // device IS remembered (LIVE_AUDIO_DEVICE_KEY), so checking it again
  // later defaults back to that device instead of the browser's own.
  // Enumerates audio-input devices into `select` and, if a stream is
  // already live, selects whichever device it's actually using (and
  // remembers it as the preference for next time) -- factored out of
  // wireLiveAudioControls so syncLiveAudioPanel below can populate a
  // panel's device list too, without needing that panel's own enable
  // flow to have been the one that started the stream.
  function populateAudioDeviceOptionsFor(select) {
    return navigator.mediaDevices.enumerateDevices().then((devices) => {
      select.textContent = "";
      devices
        .filter((d) => d.kind === "audioinput")
        .forEach((d, i) => {
          const opt = document.createElement("option");
          opt.value = d.deviceId;
          opt.textContent = d.label || "Microphone " + (i + 1);
          select.appendChild(opt);
        });
      // enableLiveAudio(null) (the checkbox's first-ever grant, or a
      // fallback from a stale saved device) picks whatever the browser
      // considers its default device, which isn't necessarily this
      // list's first entry -- read back which track actually got used,
      // select that option to match, and remember it as the preference
      // for next time.
      if (liveAudioStream) {
        const track = liveAudioStream.getAudioTracks()[0];
        const settings = track && track.getSettings && track.getSettings();
        if (settings && settings.deviceId) {
          select.value = settings.deviceId;
          savePreferredAudioDeviceId(settings.deviceId);
        }
      }
    });
  }

  // Reflects the CURRENT shared live-audio state (on/off, which device)
  // into one panel's own toggle/device-row/select/status -- called by
  // openFractal/openVisualizer on every open, not just wireLiveAudioControls
  // at build time, so a stream already started from a DIFFERENT panel
  // (the fractal's, the visualizer's, or a host page's own setup card --
  // see wireLiveAudioControls' own comment on there being up to three)
  // shows correctly the moment this one opens, instead of looking off
  // until its own checkbox is toggled even though the mic is already
  // live. Only handles turning ON to match reality -- the off state is
  // already every panel's own default and whatever disableLiveAudio
  // already resets it to, so there's nothing to sync in that direction.
  function syncLiveAudioPanel(panel) {
    if (!liveAudioStream) return;
    const toggle = panel.querySelector('[data-toggle="liveAudio"]');
    if (!toggle) return;
    toggle.checked = true;
    const row = panel.querySelector(".fractal-controls-audio-device");
    if (row) row.hidden = false;
    const select = panel.querySelector("[data-audio-device]");
    if (select) {
      populateAudioDeviceOptionsFor(select).then(() => {
        const status = panel.querySelector("[data-audio-status]");
        if (status) {
          const label = select.selectedOptions[0];
          status.textContent = "Listening" + (label ? " on " + label.textContent : "") + ".";
        }
        panel.dispatchEvent(new CustomEvent("liveaudiostatechange", { detail: { active: true } }));
      });
    }
    startWaveformLoop();
  }

  // Dispatched on `panel` itself whenever this panel's live-audio state
  // becomes definitively known -- {active: true} once enable actually
  // succeeds (device populated, status set to "Listening..."),
  // {active: false} on denial/disconnect/explicit uncheck/any other
  // panel's own stop (see disableLiveAudio's own dispatch). A host page
  // that needs to react to the outcome -- e.g. relabeling a custom
  // button once permission is granted -- listens for this instead of
  // polling the checkbox or duplicating enable/disable logic itself.
  function wireLiveAudioControls(panel) {
    const liveAudioToggle = panel.querySelector('[data-toggle="liveAudio"]');
    const audioDeviceRow = panel.querySelector(".fractal-controls-audio-device");
    const audioDeviceSelect = panel.querySelector("[data-audio-device]");
    const audioStatusEl = panel.querySelector("[data-audio-status]");

    function populateAudioDeviceOptions() {
      return populateAudioDeviceOptionsFor(audioDeviceSelect);
    }

    function handleAudioDisconnect() {
      disableLiveAudio();
      audioStatusEl.textContent = "Input device disconnected.";
    }

    const audioSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (!audioSupported) {
      liveAudioToggle.disabled = true;
      return;
    }
    liveAudioToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        audioDeviceRow.hidden = false;
        audioStatusEl.textContent = "Requesting microphone access…";
        const preferredId = audioDeviceSelect.value || loadPreferredAudioDeviceId();
        enableLiveAudioWithFallback(preferredId, handleAudioDisconnect)
          .then(populateAudioDeviceOptions)
          .then(() => {
            const label = audioDeviceSelect.selectedOptions[0];
            audioStatusEl.textContent = "Listening" + (label ? " on " + label.textContent : "") + ".";
            startWaveformLoop();
            panel.dispatchEvent(new CustomEvent("liveaudiostatechange", { detail: { active: true } }));
          })
          .catch(() => {
            disableLiveAudio();
            audioStatusEl.textContent = "Microphone access denied or unavailable.";
          });
      } else {
        disableLiveAudio();
      }
    });

    audioDeviceSelect.addEventListener("change", () => {
      if (!liveAudioToggle.checked) return;
      audioStatusEl.textContent = "Switching input…";
      savePreferredAudioDeviceId(audioDeviceSelect.value);
      enableLiveAudio(audioDeviceSelect.value, handleAudioDisconnect)
        .then(() => {
          audioStatusEl.textContent = "Listening on " + audioDeviceSelect.selectedOptions[0].textContent + ".";
        })
        .catch(() => {
          audioStatusEl.textContent = "Couldn't switch to that device.";
        });
    });
  }

  // Shared by both visualizers: a single 0-1 "how loud/energetic right
  // now" value. Live audio input only (see the comment above) -- 0
  // (no reactivity at all) whenever it isn't active, rather than
  // guessing from a precomputed waveform or a hand-noted BPM. Every
  // caller already treats 0 as a sane, fully idle/baseline pulse (no
  // zoom boost, no warp displacement, etc.).
  function computePulse() {
    return readLiveAudioPulse() || 0;
  }

  // Applied to <html> while either overlay below is open (see
  // fractalize-core.css) -- owned entirely by this file rather than
  // depending on a host page's own "modal open" class, since the engine
  // needs to work standalone (no lightbox, no host page awareness
  // required). Only removed once NEITHER overlay is open, in case a
  // future host ever allows both to exist at once.
  function lockScroll() {
    document.documentElement.classList.add("fractalize-scroll-lock");
  }
  function unlockScrollIfNeeded() {
    if (!isFractalOpen() && !isVisualizerOpen()) {
      document.documentElement.classList.remove("fractalize-scroll-lock");
    }
  }

  // Resolves `srcOrImgEl` (either an already-loaded <img> element or a
  // plain src string) to a loaded <img> element and hands it to
  // `callback`. Lets openFractal/openVisualizer accept a host's existing,
  // already-on-screen <img> (today's only real caller) just as well as a
  // bare string a future caller (e.g. an upload flow handing over a
  // freshly-created object URL) would have instead -- neither caller
  // needs to pre-load anything itself.
  function resolveImageSource(srcOrImgEl, callback) {
    if (srcOrImgEl instanceof HTMLImageElement) {
      callback(srcOrImgEl);
      return;
    }
    const img = new Image();
    // Requests the image in CORS mode -- required for a cross-origin
    // source (e.g. fractalize.studio loading a photo from
    // tuckermills.com) to ever be readable via canvas/getImageData
    // (buildPixelSampler/downscaleForTexture below both need this).
    // Without it, even a server that sends a permissive
    // Access-Control-Allow-Origin header still leaves the resulting
    // <img> "tainted" for pixel reads, because the browser only honors
    // that header for requests it actually made in CORS mode. A no-op
    // for same-origin sources (this host's own photos) and for blob:/
    // data: URLs (uploads) -- safe to set unconditionally.
    img.crossOrigin = "anonymous";
    img.src = srcOrImgEl;
    const ready = img.decode
      ? img.decode().catch(() => {})
      : new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
        });
    ready.then(() => callback(img));
  }

  // Shared by the fractal's camera-roll grid and the visualizer's own
  // "Your Uploads" section below -- a dashed square tile with a "+"
  // icon, wrapping its own hidden multi-file input so a click opens
  // the file picker with no separate wiring needed for that part. Only
  // ever created when uploadHandler is set (see its own comment above).
  function buildAddPhotoTile() {
    const label = document.createElement("label");
    label.className = "fractal-cameraroll-thumb fractal-cameraroll-add-thumb";
    label.setAttribute("aria-label", "Add photos");
    label.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="22px" height="22px" fill="#e3e3e3">' +
      '<path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/>' +
      "</svg>" +
      '<input type="file" accept="image/*" multiple hidden>';
    label.querySelector("input").addEventListener("change", (e) => {
      if (uploadHandler) uploadHandler(e.target.files);
      e.target.value = ""; // lets the same file(s) be re-selected later
    });
    return label;
  }

  // The visualizer's own "Your Uploads" -- persistent (see
  // buildAddPhotoTile's add-tile as its first entry, below) and styled
  // like the fractal's camera-roll grid (reuses its section/row/thumb
  // classes), but deliberately narrower: just this one group, and each
  // thumb only switches the visualizer to that photo (onPlay) -- no
  // queue, no shuffle, no browsing the rest of the curated catalog,
  // none of which exists for the visualizer today and none of which
  // was asked for here. photoCatalog[0] is treated as the uploads
  // group by the same first-group convention populateCameraRollGrid
  // uses (see its own comment) -- true whenever uploadHandler is set,
  // since that's only ever the case for a host page that keeps its
  // uploads group first, by its own convention, in what it hands to
  // setPhotoCatalog.
  function buildUploadsGridSection(onPlay) {
    const group = photoCatalog[0];
    const section = document.createElement("div");
    section.className = "fractal-cameraroll-section";
    const heading = document.createElement("h4");
    heading.className = "fractal-cameraroll-section-label";
    heading.textContent = (group && group.label) || "Your Uploads";
    section.appendChild(heading);
    const row = document.createElement("div");
    row.className = "fractal-cameraroll-row";
    row.appendChild(buildAddPhotoTile());
    (group ? group.photos : []).forEach((photo) => {
      const thumb = document.createElement("div");
      thumb.className = "fractal-cameraroll-thumb";
      thumb.innerHTML =
        '<img src="' + photo.thumbSrc + '" alt="" loading="lazy" decoding="async" width="200" height="200">' +
        '<div class="fractal-cameraroll-thumb-actions">' +
        '<button type="button" class="fractal-cameraroll-action" data-action="play" aria-label="Show this photo">&#9654;</button>' +
        "</div>";
      thumb.querySelector('[data-action="play"]').addEventListener("click", () => onPlay(photo.src));
      row.appendChild(thumb);
    });
    section.appendChild(row);
    return section;
  }

  function buildVisualizer() {
    const el = document.createElement("div");
    el.className = "image-visualizer";
    el.innerHTML =
      '<svg width="0" height="0" style="position:absolute">' +
      '<filter id="visualizer-warp" x="-20%" y="-20%" width="140%" height="140%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="7" result="turb"></feTurbulence>' +
      '<feDisplacementMap in="SourceGraphic" in2="turb" scale="0" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap>' +
      "</filter>" +
      "</svg>" +
      '<img class="image-visualizer-img" alt="">' +
      '<button type="button" class="image-visualizer-close" aria-label="Close visualizer">&times;</button>' +
      '<button type="button" class="image-visualizer-switch-fractal" aria-label="Switch to fractal view">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22px" height="22px" fill="#e3e3e3" fill-rule="evenodd">' +
      '<path d="M12 3 L21 20 L3 20 Z M7.5 11.5 L16.5 11.5 L12 20 Z"/>' +
      "</svg>" +
      "</button>" +
      '<button type="button" class="image-visualizer-settings-toggle" aria-label="Visualizer settings">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22px" height="22px" fill="none" ' +
      'stroke="#e3e3e3" stroke-width="2" stroke-linecap="round">' +
      '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="#e3e3e3" stroke="none"/>' +
      '<line x1="4" y1="12" x2="20" y2="12"/><circle cx="16" cy="12" r="2" fill="#e3e3e3" stroke="none"/>' +
      '<line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2" fill="#e3e3e3" stroke="none"/>' +
      "</svg>" +
      "</button>" +
      '<div class="visualizer-controls">' +
      '<div class="fractal-controls-row fractal-controls-toggle-row">' +
      '<label><input type="checkbox" data-toggle="bumpZoomEnabled"> Bump zoom</label>' +
      "</div>" +
      '<div data-live-audio-panel>' +
      '<div class="fractal-controls-row fractal-controls-toggle-row">' +
      '<label><input type="checkbox" data-toggle="liveAudio"> Live audio input</label>' +
      "</div>" +
      '<div class="fractal-controls-row fractal-controls-audio-device" hidden>' +
      '<div class="fractal-audio-device-col">' +
      '<label>Input device</label>' +
      '<select class="fractal-controls-select" data-audio-device></select>' +
      '<p class="fractal-controls-audio-status" data-audio-status></p>' +
      "</div>" +
      '<div class="fractal-audio-meter-col">' +
      '<canvas class="fractal-audio-waveform" data-audio-waveform width="200" height="58"></canvas>' +
      "</div>" +
      "</div>" +
      "</div>" +
      "</div>";
    document.body.appendChild(el);
    visualizerSettings = loadVisualizerSettings();
    const bumpZoomToggle = el.querySelector('[data-toggle="bumpZoomEnabled"]');
    bumpZoomToggle.checked = visualizerSettings.bumpZoomEnabled;
    bumpZoomToggle.addEventListener("change", (e) => {
      visualizerSettings.bumpZoomEnabled = e.target.checked;
      saveVisualizerSettings(visualizerSettings);
    });
    el.querySelector(".image-visualizer-close").addEventListener("click", closeVisualizer);
    // Read the current photo before closeVisualizer() runs -- it doesn't
    // null out visualizerImgEl itself, but this keeps the order safe
    // regardless (same defensive pattern as the fractal's own switch
    // button below, which DOES get its source nulled on close).
    el.querySelector(".image-visualizer-switch-fractal").addEventListener("click", () => {
      const src = visualizerImgEl.src;
      closeVisualizer();
      openFractal(src);
    });
    const settingsToggle = el.querySelector(".image-visualizer-settings-toggle");
    const panel = el.querySelector(".visualizer-controls");
    wireLiveAudioControls(panel);

    // Only when a host page has opted into uploads (see setUploadHandler)
    // -- built lazily, same "build once, invalidate on catalog change"
    // pattern as the fractal's own camera-roll grid (see
    // populateCameraRollGrid/cameraRollInvalidate above), so a photo
    // added/removed elsewhere is reflected next time this panel opens
    // rather than showing a stale snapshot from whenever it was first
    // built.
    let uploadsSectionEl = null;
    let uploadsBuilt = false;
    if (uploadHandler) {
      uploadsSectionEl = document.createElement("div");
      panel.insertBefore(uploadsSectionEl, el.querySelector("[data-live-audio-panel]"));
      visualizerUploadsInvalidate = function () {
        uploadsBuilt = false;
        uploadsSectionEl.innerHTML = "";
      };
    }
    function populateVisualizerUploads() {
      if (!uploadsSectionEl || uploadsBuilt) return;
      uploadsBuilt = true;
      uploadsSectionEl.appendChild(
        buildUploadsGridSection((src) => {
          if (visualizerSwitchImage) visualizerSwitchImage(src);
        })
      );
    }
    settingsToggle.addEventListener("click", () => {
      panel.classList.toggle("is-open");
      if (panel.classList.contains("is-open")) populateVisualizerUploads();
    });

    return el;
  }

  function isVisualizerOpen() {
    return !!visualizerEl && visualizerEl.classList.contains("is-open");
  }

  function openVisualizer(srcOrImgEl) {
    if (!visualizerEl) {
      visualizerEl = buildVisualizer();
      visualizerImgEl = visualizerEl.querySelector(".image-visualizer-img");
      visualizerDisplacementEl = visualizerEl.querySelector("feDisplacementMap");
      visualizerTurbulenceEl = visualizerEl.querySelector("feTurbulence");
    }
    visualizerImgEl.src = srcOrImgEl instanceof HTMLImageElement ? srcOrImgEl.getAttribute("src") : srcOrImgEl;
    visualizerSwitchImage = function (src) {
      visualizerImgEl.src = src;
    };
    visualizerEl.classList.add("is-open");
    if (visualizerEl.requestFullscreen) visualizerEl.requestFullscreen().catch(() => {});
    lockScroll();
    resetIdleHide();
    // A stream already started elsewhere (the fractal's own panel, or a
    // host page's setup card -- see syncLiveAudioPanel's own comment)
    // shows correctly here immediately, not just once this panel's own
    // checkbox is toggled.
    syncLiveAudioPanel(visualizerEl);

    // Re-seeded on open and on every cycle reset below, so the noise
    // pattern -- and so the exact shape of the warp -- differs each time,
    // per the "randomized each time" ask.
    function reseed() {
      visualizerTurbulenceEl.setAttribute("seed", String(Math.floor(Math.random() * 1000)));
    }
    reseed();
    let lastCyclePhase = 0;

    const startTime = performance.now();
    function frame(now) {
      if (!isVisualizerOpen()) return;
      const elapsedSec = (now - startTime) / 1000;

      // "Descend into fractal detail": baseFrequency and numOctaves both
      // climb across the cycle, packing in progressively finer, more
      // layered noise -- feTurbulence's own fractal octaves are what
      // make this read as "deeper" rather than just "busier" -- then
      // snap back to a shallow start and reseed for the next descent.
      const cyclePhase = (((now - startTime) % FRACTAL_CYCLE_MS) / FRACTAL_CYCLE_MS);
      if (cyclePhase < lastCyclePhase) reseed();
      lastCyclePhase = cyclePhase;
      const freq = 0.006 + cyclePhase * 0.034;
      visualizerTurbulenceEl.setAttribute("baseFrequency", `${freq.toFixed(4)} ${(freq * 1.5).toFixed(4)}`);
      visualizerTurbulenceEl.setAttribute("numOctaves", String(1 + Math.floor(cyclePhase * 4)));

      // "Bump zoom" toggle (see VISUALIZER_DEFAULTS): off means the warp's
      // displacement/zoom-scale/brightness sit at their idle values below
      // regardless of live audio, same as if the pulse were always 0 --
      // the raw analyser reading has no smoothing of its own (unlike the
      // fractal's own reactivity, whose effect is naturally damped by
      // being just one input to a slow-moving exponent, see
      // musicReactivityPct above), so this is the direct fix for anyone
      // who finds that jitter distracting rather than lively.
      const pulse = visualizerSettings.bumpZoomEnabled ? computePulse() : 0;

      visualizerDisplacementEl.setAttribute("scale", (pulse * 45).toFixed(1));
      visualizerImgEl.style.transform = `scale(${(1 + pulse * 0.06).toFixed(3)})`;
      visualizerImgEl.style.filter =
        `url(#visualizer-warp) hue-rotate(${((elapsedSec * 12) % 360).toFixed(1)}deg) brightness(${(1 + pulse * 0.15).toFixed(3)})`;
      visualizerRAF = requestAnimationFrame(frame);
    }
    visualizerRAF = requestAnimationFrame(frame);
  }

  function closeVisualizer() {
    if (!isVisualizerOpen()) return;
    visualizerEl.classList.remove("is-open");
    cancelAnimationFrame(visualizerRAF);
    visualizerSwitchImage = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    unlockScrollIfNeeded();
    // No stray mic indicator lingering after the visitor leaves -- resets
    // every live-audio panel on the page, not just this one (see
    // disableLiveAudio's own comment) -- unless the host page opted out
    // via setKeepLiveAudioOnClose (see that flag's own comment).
    if (!keepLiveAudioOnClose) disableLiveAudio();
    visualizerEl.classList.remove("chrome-hidden");
    clearIdleHide();
  }

  // "Mandelbrot zoom": a fullscreen WebGL view of a photo as a Julia set
  // (z = z^2 + c, fixed c, z0 = pixel position -- a Mandelbrot is the
  // same formula with c = pixel position instead, but a fixed c is what
  // lets that c be driven by the photo, see below). No canvas library, no
  // 3rd-party WebGL helper -- a small hand-written shader.
  //
  // "Closely informed by the source image": the photo is a texture the
  // shader samples using the *iterated* coordinate (not the screen
  // coordinate), so the rendered colors are the photo's own colors,
  // warped through the fractal's math rather than a generic palette. And
  // literally injected into the formula, per the ask: every few seconds,
  // a fresh pixel is sampled from the photo (via an offscreen 2D canvas,
  // read once into a plain array -- cheap, no repeated getImageData
  // calls) and mapped to a new Julia constant c, smoothly interpolated
  // into. Each injection also resets the zoom, so one "dive" = one fresh
  // sample of the photo.
  const MANDELBROT_CYCLE_MS = 6000;

  // Shown in the fractal settings panel's bottom-right corner -- the
  // short hash of the last commit pushed to this file's repo, updated by
  // hand as part of each commit that touches this file (no build step to
  // inject it automatically). One commit behind true HEAD is expected:
  // the commit that bumps this string can't know its own hash in
  // advance, so it always reflects the *previous* push.
  const FRACTAL_VERSION = "v991ad96";

  // Per-visitor settings. ogMode is read by both dive styles; every
  // other key here only affects Smooth mode (see frame() below) -- OG
  // Fractal stays deaf to all of them by design, so it keeps
  // reproducing the exact original behavior no matter how these are
  // tuned.
  const FRACTAL_DEFAULTS = {
    ogMode: false,
    // Neither of these existed in the fractal at all before this
    // panel -- computePulse was only ever wired into the noise-warp
    // visualizer, and growth's iteration-budget machinery was removed
    // in an earlier revert and never came back. Off/0 is the accurate
    // "current behavior" default for both, not a guess.
    musicReactivityPct: 0,
    // How much of each frame's smoothed pulse carries over into the
    // next, vs. the raw analyser reading (see the smoothing math in
    // frame() below) -- 0 reproduces the original un-smoothed behavior
    // exactly. Defaulted on (not 0) since a visitor turning up "Music
    // reactivity" for the first time is specifically looking for a
    // pleasant wobble, not raw meter jitter; still fully adjustable back
    // down to 0 for anyone who prefers the snappier original feel.
    reactivitySmoothingPct: 30,
    growthEnabled: false,
    // 7x is the proven-safe ceiling this whole mode is built around
    // (see the "Smooth mode" comment above injectFromImage below) --
    // same default as what's hardcoded today, just now adjustable.
    zoomDepth: 7,
    cycleDurationSec: 20,
    // 2 is the classic z^2+c shape everything else here was tuned
    // around -- replaces the per-open weighted-random roll a previous
    // version used to fight repetitive shapes; this slider is direct
    // manual control instead, see its wiring in buildFractal below.
    fractalPower: 2,
    // 30%, not 100% ("current behavior") -- once detail got a real
    // saturation/vividness boost (boostDetail in FRAGMENT_SHADER), the
    // background started reading noticeably brighter/more saturated by
    // contrast next to it, even though its own color never changed.
    // Lowered again from an initial 60% after user feedback that 60%
    // still read "much too bright and overly saturated" vs. the source
    // photo -- 30% is a real fix baked into the default, not a neutral
    // starting point; the slider still runs 0-150% either direction.
    bgSaturationPct: 30,
    // On by default -- see the "Avoid empty spaces" watchdog in frame()
    // below. Off gives back the old, un-mitigated flat-space behavior
    // for anyone who wants it (explicit user feedback: "even the effect
    // of the flashing emptiness is beautiful" to some).
    avoidEmptySpaces: true,
    // Camera roll queue -- src strings from the host's photo catalog
    // (see setPhotoCatalog below), persisted so a visitor's curated
    // queue survives reloads. Starts empty; openFractal auto-adds
    // whichever photo it opened on if it isn't already present (unless
    // opts.persistQueue is false -- see openFractal), so the queue
    // always has at least one entry once the fractal's been opened once.
    imageQueue: [],
    shuffleEnabled: false,
    shuffleTimerSec: 30,
    // Randomizer (the settings panel's own) -- periodically rerolls
    // Fractal shape/Background saturation/Zoom depth/Cycle duration to
    // random values within their own slider ranges. Same timer-interval
    // pattern as the camera roll's shuffle, see startRandomizerTimer in
    // buildFractal.
    randomizerEnabled: false,
    randomizerTimerSec: 30,
    // Trades visual thoroughness for raw frame rate on slower machines:
    // caps canvas resolution to 1x device-pixel-ratio (see resize()),
    // halves the shader's per-pixel iteration budget (see maxIter in
    // frame()), searches fewer/cheaper candidates in injectFromImage
    // (the biggest single cost -- a synchronous CPU scoring loop that
    // runs on every cycle wrap, RANDOMIZE NOW, and Fractal-shape drag),
    // and drops the settings/camera-roll panels' backdrop-filter blur
    // (continuously recomputed over an animating full-bleed canvas --
    // see resize()'s own comment on why that's expensive). Off by
    // default since it's a real, visible quality tradeoff, not a free
    // win.
    lowPerformanceMode: false,
  };
  const FRACTAL_SETTINGS_KEY = "tuckerMillsFractalSettings";
  // Pill choices for the camera roll's shuffle timer -- deliberately not
  // a plain range slider (see buildFractal's camera-roll panel), so a
  // fixed short list of "modern, clean, but unique" stops instead of a
  // continuous 10-120 range.
  const SHUFFLE_TIMER_OPTIONS = [
    { sec: 10, label: "10s" },
    { sec: 20, label: "20s" },
    { sec: 30, label: "30s" },
    { sec: 45, label: "45s" },
    { sec: 60, label: "1m" },
    { sec: 90, label: "1.5m" },
    { sec: 120, label: "2m" },
  ];

  function loadFractalSettings() {
    try {
      const raw = localStorage.getItem(FRACTAL_SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return Object.assign({}, FRACTAL_DEFAULTS, parsed);
    } catch (e) {
      return Object.assign({}, FRACTAL_DEFAULTS);
    }
  }

  function saveFractalSettings(settings) {
    try {
      localStorage.setItem(FRACTAL_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      // Private browsing / storage disabled -- settings just won't
      // persist across visits, nothing else depends on this succeeding.
    }
  }

  const VERTEX_SHADER = "attribute vec2 aPos;\n" + "void main() { gl_Position = vec4(aPos, 0.0, 1.0); }\n";
  const FRAGMENT_SHADER =
    "precision highp float;\n" +
    "uniform vec2 uResolution;\n" +
    "uniform float uZoom;\n" +
    "uniform vec2 uC;\n" +
    "uniform vec2 uCenter;\n" +
    "uniform vec3 uBaseColor;\n" +
    "uniform sampler2D uImage;\n" +
    // A second photo texture + a sweep progress value (roughly -0.3 to
    // 1.3, see requestImageSwitch/frame() in openFractal), sampled at
    // the exact same iterated UV as uImage (see sampleImage below) --
    // lets a live image switch reveal the incoming photo growing outward
    // from the fractal's own deepest structure while the fractal shape
    // itself keeps moving, instead of freezing, hard-swapping the
    // texture, and unfreezing. Outside of an active switch this sits at
    // -0.3 (fully "off" for every pixel, see sampleImage), so the extra
    // sample costs a bit of fill rate at all times but is only visible
    // during the brief transition window.
    "uniform sampler2D uImageNext;\n" +
    "uniform float uImageBlend;\n" +
    "uniform float uMaxIter;\n" +
    "uniform float uPower;\n" +
    "uniform float uBgSaturation;\n" +
    // Standard compact GLSL RGB<->HSV pair, used by boostDetail below to
    // boost only the photo-sampled "detail" color (texColor, both
    // branches), and separately to scale uBaseColor's own saturation via
    // the "Background saturation" slider (see the mix below) -- the two
    // never share one adjustment, so a background tweak and a detail
    // tweak stay independent levers instead of one blunt post-process.
    // Texture sampling loses real
    // vividness vs. the source photo two ways: LINEAR filtering blends
    // across neighboring pixels of very different color (the z-driven UV
    // jumps chaotically frame to frame, so "neighboring" here isn't
    // spatially coherent the way a normal texture map is), and every
    // exterior-branch pixel still has *some* uBaseColor mixed in via t<1
    // even at high iteration counts, both of which dull the actual photo
    // detail that's supposed to be showing through.
    "vec3 rgb2hsv(vec3 c) {\n" +
    "  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);\n" +
    "  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));\n" +
    "  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));\n" +
    "  float d = q.x - min(q.w, q.y);\n" +
    "  float e = 1.0e-10;\n" +
    "  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);\n" +
    "}\n" +
    "vec3 hsv2rgb(vec3 c) {\n" +
    "  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);\n" +
    "  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);\n" +
    "  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);\n" +
    "}\n" +
    "vec3 boostDetail(vec3 c) {\n" +
    "  vec3 hsv = rgb2hsv(c);\n" +
    "  hsv.y = clamp(hsv.y * 2.6, 0.0, 1.0);\n" +
    "  hsv.z = clamp(hsv.z * 1.4, 0.0, 1.0);\n" +
    "  return hsv2rgb(hsv);\n" +
    "}\n" +
    // t (0-1) is how "deep" this pixel's fractal position is -- near-
    // boundary/interior points (real detail, see the exterior branch's
    // own t below) pass a high t, quickly-escaping background points
    // pass a low one. Rather than a flat screen-wide fade, uImageBlend
    // sweeps a threshold across this same range (see its own comment
    // above): high-t pixels cross first, low-t pixels cross last, so
    // the incoming photo visibly grows outward from the fractal's own
    // most intricate structure toward the background over the course of
    // the transition, instead of the whole screen fading in unison.
    "vec3 sampleImage(vec2 uv, float t) {\n" +
    "  float band = 0.3;\n" +
    "  float pixelThreshold = 1.0 - t;\n" +
    "  float revealed = smoothstep(pixelThreshold - band, pixelThreshold + band, uImageBlend);\n" +
    "  return mix(texture2D(uImage, uv).rgb, texture2D(uImageNext, uv).rgb, revealed);\n" +
    "}\n" +
    // Complex z^power via repeated multiplication (no atan2/log, so no
    // branch-cut seam artifact) rather than a fixed square -- driven by
    // the "Fractal shape" slider (fractalPower in buildFractal below) so
    // 2/3/4/5/6-fold rotational symmetry is a direct, live-adjustable
    // choice instead of just a different c on the same z^2+c shape every
    // time. Loop bound is a compile-time constant (uPower itself is a
    // runtime float, same pattern as uMaxIter above) capped at power=6 --
    // juliaIterations in JS must stay in lockstep, since scoring
    // validates candidates against this exact formula.
    "vec2 cplxPow(vec2 z, float power) {\n" +
    "  vec2 r = z;\n" +
    "  for (int k = 1; k < 6; k++) {\n" +
    "    if (float(k) >= power) break;\n" +
    "    r = vec2(r.x * z.x - r.y * z.y, r.x * z.y + r.y * z.x);\n" +
    "  }\n" +
    "  return r;\n" +
    "}\n" +
    "void main() {\n" +
    "  vec2 uv = gl_FragCoord.xy / uResolution;\n" +
    "  vec2 p = uv - 0.5;\n" +
    "  p.x *= uResolution.x / uResolution.y;\n" +
    "  vec2 z = p / uZoom + uCenter;\n" +
    "  float iter = 0.0;\n" +
    "  for (int i = 0; i < 150; i++) {\n" +
    "    if (float(i) >= uMaxIter) break;\n" +
    "    if (dot(z, z) > 4.0) break;\n" +
    "    z = cplxPow(z, uPower) + uC;\n" +
    "    iter += 1.0;\n" +
    "  }\n" +
    "  if (iter >= uMaxIter) {\n" +
    // Interior points (never escaped) are the fractal's own deepest,
    // most detailed structure -- always t=1.0, so this is where an
    // incoming photo reveals first during a crossfade.
    "    vec3 texColor = boostDetail(sampleImage(fract(z * 0.5 + 0.5), 1.0));\n" +
    "    gl_FragColor = vec4(texColor, 1.0);\n" +
    "  } else {\n" +
    // A steeper curve than sqrt (which is pow(x, 0.5)) -- iter/uMaxIter
    // reaching even a moderate fraction now pushes t close to 1 quickly,
    // so pixels with real boundary detail nearby (moderate iteration
    // counts, not just ones right at the brink of uMaxIter) read as
    // close to pure texColor instead of a wash that's still 30-50%
    // uBaseColor. That baseColor bleed was diluting the *detail* itself,
    // not just the flat background regions boostDetail above was never
    // meant to touch -- this is the fix for that, boostDetail alone
    // couldn't compensate for dilution happening after it runs.
    "    float t = pow(iter / uMaxIter, 0.3);\n" +
    "    vec3 texColor = boostDetail(sampleImage(fract(z * 0.2 + 0.5), t));\n" +
    // uBaseColor itself stays exactly the photo-average value set once
    // in openFractal -- this only scales its *saturation* (hue/value
    // untouched), live-adjustable via the "Background saturation"
    // slider, independent from boostDetail's own fixed detail-color
    // boost above. Needed once detail got noticeably more vivid: the
    // background reads *relatively* brighter/more saturated next to it
    // now than it used to, even though uBaseColor's own value never
    // changed -- a contrast effect, not a bug in either boost.
    "    vec3 bgHsv = rgb2hsv(uBaseColor);\n" +
    "    bgHsv.y = clamp(bgHsv.y * uBgSaturation, 0.0, 1.0);\n" +
    "    vec3 bgColor = hsv2rgb(bgHsv);\n" +
    "    gl_FragColor = mix(vec4(bgColor, 1.0), vec4(texColor, 1.0), t);\n" +
    "  }\n" +
    "}\n";

  let fractalEl = null;
  let fractalCanvasEl = null;
  let fractalGl = null;
  let fractalUniforms = null;
  let fractalTexture = null;
  // The "incoming" photo's texture during a live image-switch crossfade
  // (see requestImageSwitch/frame() below) -- holds whatever was most
  // recently faded FROM once a crossfade completes (the two GL texture
  // objects just swap which variable calls them "current", no
  // reallocation), so it's always a valid, already-uploaded texture even
  // outside of an active switch, never left pointing at nothing.
  let fractalTextureNext = null;
  let fractalRAF = null;
  let fractalSamplePixel = null; // (u, v) -> {r, g, b}, built once per photo
  let fractalSettings = null; // loaded/mutated live by the settings panel
  // The active openFractal() session's own injectFromImage, so the
  // settings panel (built once in buildFractal, reused across opens) can
  // trigger an immediate re-score/re-injection when a setting that
  // changes the fractal's actual shape (the "Fractal shape" power
  // slider) is dragged -- otherwise the currently-displayed c/center,
  // scored and chosen for the *previous* power, could read as flat under
  // the new one until the next naturally-scheduled cycle wrap. Null
  // whenever the fractal view is closed, see closeFractal.
  let activeReinject = null;
  // Same pattern as activeReinject above, for the camera roll: the
  // active session's own image-switch trigger, so the camera roll panel
  // (built once, reused across opens) and the shuffle timer (which
  // outlives any single open) can start a live transition to a
  // different photo. Null whenever the fractal view is closed.
  let activeImageSwitch = null;
  // Same pattern again, for the active session's own resize() -- so the
  // "Low performance mode" checkbox (see FRACTAL_DEFAULTS) can force an
  // immediate re-resolution the moment it's toggled, rather than waiting
  // for an actual window resize or a settings-panel open/close to
  // happen to fire it next. Null whenever the fractal view is closed.
  let activeResize = null;
  // Mirrors whichever photo the active session is currently showing --
  // read by the camera roll panel for its "now playing" highlight and
  // by the shuffle timer to avoid picking the same photo twice in a row.
  let activeCurrentImageSrc = null;
  // Camera-roll panel hooks, set once inside buildFractal (the panel is
  // built once, lazily, on the first open -- see openFractal) so the
  // separate openFractal/closeFractal functions can refresh the panel's
  // queued/now-playing badges and drive the shuffle timer without
  // reaching into buildFractal's own closure.
  let cameraRollRefreshBadges = null;
  let cameraRollStartShuffleTimer = null;
  let cameraRollStopShuffleTimer = null;
  // Same pattern again -- lets setPhotoCatalog (see the bottom of this
  // file) invalidate the camera-roll grid's own "build once" cache
  // (see populateCameraRollGrid) when the catalog changes after it's
  // already been built once. Written for fractalize-studio specifically:
  // tuckermills.com calls setPhotoCatalog exactly once and never again,
  // so this was never reachable there, but a host page whose catalog can
  // change mid-session (uploads added/removed) needs the NEXT camera-
  // roll open to reflect that, not a stale snapshot from the first one.
  let cameraRollInvalidate = null;
  // Same pattern again, for the visualizer's own "Your Uploads" section
  // (see buildUploadsGridSection/buildVisualizer above) -- only ever
  // set when a host page has opted into uploads, since that section
  // only exists in that case.
  let visualizerUploadsInvalidate = null;
  // Same pattern as the camera-roll hooks above, for the settings
  // panel's own Randomizer -- also built once inside buildFractal, so
  // openFractal/closeFractal can start/stop its timer without reaching
  // into buildFractal's closure directly.
  let settingsPanelStartRandomizerTimer = null;
  let settingsPanelStopRandomizerTimer = null;
  // Lets the visualizer's own "Your Uploads" grid (see
  // buildUploadsGridSection) switch the currently showing photo without
  // closing/reopening the overlay -- set for the duration of an active
  // visualizer session (openVisualizer/closeVisualizer below), same
  // "active session hook" pattern as the fractal's own
  // activeImageSwitch just above, which this deliberately does NOT
  // reuse: the visualizer has no queue/shuffle concept for
  // activeImageSwitch's own candidates logic to apply to, just a
  // single currently-displayed photo.
  let visualizerSwitchImage = null;
  // Set via setPhotoCatalog (see the bottom of this file) -- the camera
  // roll's own photo grid reads this instead of calling any page-global
  // gallery function directly, so this file has zero dependency on how
  // (or whether) a host page organizes its own photo data.
  let photoCatalog = [];
  // Set via setUploadHandler (see the bottom of this file) -- when set,
  // an "add photos" tile appears in the fractal's camera-roll grid and
  // the visualizer's own settings panel (see buildAddPhotoTile below),
  // and picking file(s) there calls this with the resulting FileList.
  // Null by default, so neither tile renders at all unless a host page
  // opts in: tuckermills.com never calls setUploadHandler (no upload
  // feature there), fractalize-studio does.
  let uploadHandler = null;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error("Fractal shader failed to compile: " + info);
    }
    return shader;
  }

  function buildFractal() {
    const el = document.createElement("div");
    el.className = "image-fractal";
    el.innerHTML =
      '<canvas class="image-fractal-canvas"></canvas>' +
      '<button type="button" class="image-fractal-close" aria-label="Close fractal view">&times;</button>' +
      '<div class="fractal-cameraroll">' +
      '<div class="fractal-cameraroll-header">' +
      '<label class="fractal-cameraroll-shuffle"><input type="checkbox" data-toggle="shuffleEnabled"> Enable shuffle</label>' +
      '<div class="fractal-shuffle-timer" data-shuffle-timer role="group" aria-label="Shuffle timer">' +
      SHUFFLE_TIMER_OPTIONS.map(
        (opt) => '<button type="button" class="fractal-shuffle-pill" data-shuffle-sec="' + opt.sec + '">' + opt.label + "</button>"
      ).join("") +
      "</div>" +
      "</div>" +
      '<div class="fractal-cameraroll-grid" data-cameraroll-grid></div>' +
      "</div>" +
      '<div class="fractal-controls">' +
      '<div class="fractal-controls-row fractal-controls-toggle-row">' +
      '<label><input type="checkbox" data-toggle="lowPerformanceMode"> Low performance mode</label>' +
      "</div>" +
      '<div class="fractal-controls-randomizer">' +
      '<label class="fractal-controls-randomizer-toggle"><input type="checkbox" data-toggle="randomizerEnabled"> Randomizer</label>' +
      '<div class="fractal-controls-randomizer-timer" data-randomizer-timer role="group" aria-label="Randomizer timer">' +
      SHUFFLE_TIMER_OPTIONS.map(
        (opt) => '<button type="button" class="fractal-controls-randomizer-pill" data-randomizer-sec="' + opt.sec + '">' + opt.label + "</button>"
      ).join("") +
      '<button type="button" class="fractal-controls-randomize-now" data-randomize-now>RANDOMIZE NOW</button>' +
      "</div>" +
      "</div>" +
      '<div class="fractal-controls-row"><label>Music reactivity <span class="fractal-controls-value" data-value-for="musicReactivityPct"></span></label>' +
      '<input type="range" data-setting="musicReactivityPct" min="0" max="100" step="5"></div>' +
      '<div class="fractal-controls-row"><label>Reactivity smoothing <span class="fractal-controls-value" data-value-for="reactivitySmoothingPct"></span></label>' +
      '<input type="range" data-setting="reactivitySmoothingPct" min="0" max="100" step="5"></div>' +
      '<div data-live-audio-panel>' +
      '<div class="fractal-controls-row fractal-controls-toggle-row">' +
      '<label><input type="checkbox" data-toggle="liveAudio"> Live audio input</label>' +
      "</div>" +
      '<div class="fractal-controls-row fractal-controls-audio-device" hidden>' +
      '<div class="fractal-audio-device-col">' +
      '<label>Input device</label>' +
      '<select class="fractal-controls-select" data-audio-device></select>' +
      '<p class="fractal-controls-audio-status" data-audio-status></p>' +
      "</div>" +
      '<div class="fractal-audio-meter-col">' +
      '<canvas class="fractal-audio-waveform" data-audio-waveform width="200" height="58"></canvas>' +
      "</div>" +
      "</div>" +
      "</div>" +
      '<div class="fractal-controls-row"><label>Fractal shape <span class="fractal-controls-value" data-value-for="fractalPower"></span></label>' +
      '<input type="range" data-setting="fractalPower" min="2" max="6" step="1"></div>' +
      '<div class="fractal-controls-row"><label>Background saturation <span class="fractal-controls-value" data-value-for="bgSaturationPct"></span></label>' +
      '<input type="range" data-setting="bgSaturationPct" min="0" max="150" step="5"></div>' +
      '<div class="fractal-controls-row"><label>Zoom depth <span class="fractal-controls-value" data-value-for="zoomDepth"></span></label>' +
      '<input type="range" data-setting="zoomDepth" min="1" max="15" step="0.5"></div>' +
      '<div class="fractal-controls-row"><label>Cycle duration <span class="fractal-controls-value" data-value-for="cycleDurationSec"></span></label>' +
      '<input type="range" data-setting="cycleDurationSec" min="6" max="60" step="1"></div>' +
      '<div class="fractal-controls-row fractal-controls-toggle-row">' +
      '<label><input type="checkbox" data-toggle="avoidEmptySpaces"> Avoid empty spaces</label>' +
      "</div>" +
      '<div class="fractal-controls-row fractal-controls-toggle-row">' +
      '<label><input type="checkbox" data-toggle="growthEnabled"> Fractal growth</label>' +
      "</div>" +
      '<div class="fractal-controls-row fractal-controls-toggle-row">' +
      '<label><input type="checkbox" data-toggle="ogMode"> OG Fractal</label>' +
      "</div>" +
      '<div class="fractal-controls-version">' + FRACTAL_VERSION + "</div>" +
      "</div>" +
      // Sits after both bottom sheets above in the DOM specifically so it
      // paints above them (see the file's own stacking convention --
      // later DOM order wins within a shared stacking context) rather
      // than getting covered by whichever one is open. That's required,
      // not just cosmetic: its own settings/camera-roll buttons are the
      // only way to close either sheet again short of closing the whole
      // fractal, so they have to stay reachable while one is open. Close
      // itself lives back up in its own top-right corner (see above) --
      // grouping it with settings/camera-roll/switch-visualizer here read
      // as "another mode toggle" rather than "leave", so it's deliberately
      // NOT part of this bar, just styled to match it.
      '<div class="image-fractal-toolbar">' +
      '<button type="button" class="image-fractal-settings-toggle" aria-label="Fractal settings">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22px" height="22px" fill="none" ' +
      'stroke="#e3e3e3" stroke-width="2" stroke-linecap="round">' +
      '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="#e3e3e3" stroke="none"/>' +
      '<line x1="4" y1="12" x2="20" y2="12"/><circle cx="16" cy="12" r="2" fill="#e3e3e3" stroke="none"/>' +
      '<line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2" fill="#e3e3e3" stroke="none"/>' +
      "</svg>" +
      "</button>" +
      '<button type="button" class="image-fractal-cameraroll-toggle" aria-label="Photo camera roll">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="22px" height="22px" fill="#e3e3e3">' +
      '<path d="M160-80q-33 0-56.5-23.5T80-160v-600q0-33 23.5-56.5T160-840h40v-40q0-17 11.5-28.5T240-920h160q17 0 28.5 11.5T440-880v40h40q33 0 56.5 23.5T560-760h320v600H560q0 33-23.5 56.5T480-80H160Zm0-80h320v-80h320v-440H480v-80H160v600Zm200-120h80v-80h-80v80Zm0-280h80v-80h-80v80Zm160 280h80v-80h-80v80Zm0-280h80v-80h-80v80Zm160 280h80v-80h-80v80Zm0-280h80v-80h-80v80ZM320-460Z"/>' +
      "</svg>" +
      "</button>" +
      '<button type="button" class="image-fractal-switch-visualizer" aria-label="Switch to visualizer">' +
      '<svg xmlns="http://www.w3.org/2000/svg" height="22px" viewBox="0 -960 960 960" width="22px" fill="#e3e3e3">' +
      '<path d="M852-212 732-332l56-56 120 120-56 56ZM708-692l-56-56 120-120 56 56-120 120Zm-456 0L132-812l56-56 120 120-56 56ZM108-212l-56-56 120-120 56 56-120 120Zm246-75 126-76 126 77-33-144 111-96-146-13-58-136-58 135-146 13 111 97-33 143ZM233-120l65-281L80-590l288-25 112-265 112 265 288 25-218 189 65 281-247-149-247 149Zm247-361Z"/>' +
      "</svg>" +
      "</button>" +
      "</div>";
    document.body.appendChild(el);

    fractalSettings = loadFractalSettings();
    const toggleBtn = el.querySelector(".image-fractal-settings-toggle");
    const panel = el.querySelector(".fractal-controls");
    const cameraRollToggleBtn = el.querySelector(".image-fractal-cameraroll-toggle");
    const cameraRollPanel = el.querySelector(".fractal-cameraroll");
    // Read by the active session's resize()/frame() (see openFractal) to
    // downscale canvas resolution while either bottom sheet is open --
    // see resize()'s own comment for why that's worth doing.
    function syncPanelOpenClass() {
      el.classList.toggle("panel-open", panel.classList.contains("is-open") || cameraRollPanel.classList.contains("is-open"));
    }
    toggleBtn.addEventListener("click", () => {
      cameraRollPanel.classList.remove("is-open");
      panel.classList.toggle("is-open");
      syncPanelOpenClass();
    });
    cameraRollToggleBtn.addEventListener("click", () => {
      panel.classList.remove("is-open");
      cameraRollPanel.classList.toggle("is-open");
      syncPanelOpenClass();
      if (cameraRollPanel.classList.contains("is-open")) populateCameraRollGrid();
    });

    // Shuffle timer lives in this (buildFractal's own) closure, built
    // once alongside the button wiring above, since it must persist
    // across the *panel's* lifetime rather than get torn down and
    // rebuilt on every fractal open -- it only ever calls whatever
    // activeImageSwitch currently points at, so it's naturally a no-op
    // whenever the fractal itself is closed.
    let shuffleTimerHandle = null;
    function stopShuffleTimer() {
      if (shuffleTimerHandle) clearInterval(shuffleTimerHandle);
      shuffleTimerHandle = null;
    }
    function startShuffleTimer() {
      stopShuffleTimer();
      if (!fractalSettings.shuffleEnabled || fractalSettings.imageQueue.length < 2) return;
      shuffleTimerHandle = setInterval(() => {
        if (!activeImageSwitch) return;
        const candidates = fractalSettings.imageQueue.filter((s) => s !== activeCurrentImageSrc);
        if (!candidates.length) return;
        activeImageSwitch(candidates[Math.floor(Math.random() * candidates.length)]);
      }, fractalSettings.shuffleTimerSec * 1000);
    }
    cameraRollStartShuffleTimer = startShuffleTimer;
    cameraRollStopShuffleTimer = stopShuffleTimer;

    const shuffleToggle = cameraRollPanel.querySelector('[data-toggle="shuffleEnabled"]');
    shuffleToggle.checked = fractalSettings.shuffleEnabled;
    shuffleToggle.addEventListener("change", (e) => {
      fractalSettings.shuffleEnabled = e.target.checked;
      saveFractalSettings(fractalSettings);
      startShuffleTimer();
    });

    const shuffleTimerEl = cameraRollPanel.querySelector("[data-shuffle-timer]");
    const shufflePills = Array.prototype.slice.call(shuffleTimerEl.querySelectorAll(".fractal-shuffle-pill"));
    function updateShufflePillStates() {
      shufflePills.forEach((pill) => {
        pill.classList.toggle("is-active", Number(pill.dataset.shuffleSec) === fractalSettings.shuffleTimerSec);
      });
    }
    updateShufflePillStates();
    shufflePills.forEach((pill) => {
      pill.addEventListener("click", () => {
        fractalSettings.shuffleTimerSec = Number(pill.dataset.shuffleSec);
        saveFractalSettings(fractalSettings);
        updateShufflePillStates();
        startShuffleTimer();
      });
    });

    // The photo grid itself is built once, lazily, the first time the
    // camera roll panel is actually opened (see the toggle click handler
    // above) -- mirrors fractalEl's own lazy build in openFractal --
    // then just refreshed in place (queued/now-playing badges) on every
    // later open, rather than rebuilding the DOM from scratch each time.
    let cameraRollBuilt = false;
    const cameraRollGrid = cameraRollPanel.querySelector("[data-cameraroll-grid]");
    function updateCameraRollBadges() {
      const thumbs = cameraRollGrid.querySelectorAll("[data-photo-src]");
      for (let i = 0; i < thumbs.length; i++) {
        const thumb = thumbs[i];
        const src = thumb.dataset.photoSrc;
        thumb.classList.toggle("is-queued", fractalSettings.imageQueue.indexOf(src) !== -1);
        thumb.classList.toggle("is-playing", src === activeCurrentImageSrc);
      }
    }
    cameraRollRefreshBadges = updateCameraRollBadges;
    cameraRollInvalidate = function () {
      cameraRollBuilt = false;
      cameraRollGrid.innerHTML = "";
    };
    function populateCameraRollGrid() {
      if (cameraRollBuilt) {
        updateCameraRollBadges();
        return;
      }
      cameraRollBuilt = true;
      const groups = photoCatalog;
      const frag = document.createDocumentFragment();
      groups.forEach((group, groupIndex) => {
        const section = document.createElement("div");
        section.className = "fractal-cameraroll-section";
        const heading = document.createElement("h4");
        heading.className = "fractal-cameraroll-section-label";
        heading.textContent = group.label;
        section.appendChild(heading);
        const row = document.createElement("div");
        row.className = "fractal-cameraroll-row";
        // Leads the FIRST group's row, not a section of its own -- a
        // host page that's opted into uploads (see setUploadHandler)
        // keeps that group first in whatever it hands to
        // setPhotoCatalog by the same convention this relies on (see
        // fractalize-studio's own rebuildFullCatalog), so this always
        // lands inside "Your Uploads" specifically, persistent there
        // even with zero uploads, exactly like that page's own section.
        if (groupIndex === 0 && uploadHandler) row.appendChild(buildAddPhotoTile());
        group.photos.forEach((photo) => {
          const thumb = document.createElement("div");
          thumb.className = "fractal-cameraroll-thumb";
          thumb.dataset.photoSrc = photo.src;
          thumb.innerHTML =
            '<img src="' + photo.thumbSrc + '" alt="" loading="lazy" decoding="async" width="200" height="200">' +
            '<div class="fractal-cameraroll-thumb-actions">' +
            '<button type="button" class="fractal-cameraroll-action" data-action="queue" aria-label="Add to queue">+</button>' +
            '<button type="button" class="fractal-cameraroll-action" data-action="play" aria-label="Play now">&#9654;</button>' +
            "</div>";
          thumb.querySelector('[data-action="queue"]').addEventListener("click", () => {
            const idx = fractalSettings.imageQueue.indexOf(photo.src);
            if (idx === -1) fractalSettings.imageQueue.push(photo.src);
            else fractalSettings.imageQueue.splice(idx, 1);
            saveFractalSettings(fractalSettings);
            updateCameraRollBadges();
            startShuffleTimer();
          });
          thumb.querySelector('[data-action="play"]').addEventListener("click", () => {
            if (fractalSettings.imageQueue.indexOf(photo.src) === -1) {
              fractalSettings.imageQueue.push(photo.src);
              saveFractalSettings(fractalSettings);
            }
            if (activeImageSwitch) activeImageSwitch(photo.src);
            updateCameraRollBadges();
          });
          row.appendChild(thumb);
        });
        section.appendChild(row);
        frag.appendChild(section);
      });
      cameraRollGrid.appendChild(frag);
      updateCameraRollBadges();
    }

    // Sliders that OG Fractal deliberately ignores (see its own branch
    // in frame() below) -- ogMode always reproduces the original
    // behavior verbatim regardless of what these are set to.
    const FRACTAL_CONTROL_FORMATS = {
      musicReactivityPct: (v) => v + "%",
      reactivitySmoothingPct: (v) => v + "%",
      fractalPower: (v) => v + "-fold",
      bgSaturationPct: (v) => v + "%",
      zoomDepth: (v) => v + "x",
      cycleDurationSec: (v) => v + "s",
    };
    Object.keys(FRACTAL_CONTROL_FORMATS).forEach((key) => {
      const input = panel.querySelector('[data-setting="' + key + '"]');
      const valueEl = panel.querySelector('[data-value-for="' + key + '"]');
      input.value = fractalSettings[key];
      valueEl.textContent = FRACTAL_CONTROL_FORMATS[key](fractalSettings[key]);
      input.addEventListener("input", () => {
        fractalSettings[key] = Number(input.value);
        valueEl.textContent = FRACTAL_CONTROL_FORMATS[key](fractalSettings[key]);
        saveFractalSettings(fractalSettings);
      });
    });

    // Unlike the other sliders, changing shape changes what the
    // currently-displayed c/center actually looks like -- they were
    // scored/chosen for the *previous* power, and the same point can
    // read as flat under a different one. A short, snappy re-injection
    // (not the full cycle-length blend an ordinary wrap uses) makes the
    // slider feel directly responsive instead of leaving a stale/
    // possibly-flat view on screen until the next scheduled cycle wrap.
    // Debounced rather than firing on every single "input" event: a drag
    // fires dozens of those in a couple hundred milliseconds, and
    // injectFromImage's scoring loop is the single most expensive thing
    // in this file (see MAX_ATTEMPTS above) -- running it dozens of
    // times over one drag, not once after it settles, was the actual
    // cause of a slider that felt like it was fighting the frame rate.
    let fractalPowerReinjectTimer = null;
    panel.querySelector('[data-setting="fractalPower"]').addEventListener("input", () => {
      clearTimeout(fractalPowerReinjectTimer);
      fractalPowerReinjectTimer = setTimeout(() => {
        if (activeReinject) activeReinject(performance.now(), 1200);
      }, 150);
    });

    // Randomizer: periodically (or on demand, via RANDOMIZE NOW) rerolls
    // the four sliders above to random values within their own existing
    // min/max/step -- reading those straight off each <input> rather
    // than duplicating the ranges here, so a future slider-range tweak
    // can't silently drift out of sync with what Randomizer picks from.
    const RANDOMIZABLE_KEYS = ["fractalPower", "bgSaturationPct", "zoomDepth", "cycleDurationSec"];
    function randomizeFractalSettings() {
      RANDOMIZABLE_KEYS.forEach((key) => {
        const input = panel.querySelector('[data-setting="' + key + '"]');
        const valueEl = panel.querySelector('[data-value-for="' + key + '"]');
        const min = Number(input.min);
        const max = Number(input.max);
        const step = Number(input.step);
        const steps = Math.round((max - min) / step);
        const value = min + Math.round(Math.random() * steps) * step;
        fractalSettings[key] = value;
        input.value = value;
        valueEl.textContent = FRACTAL_CONTROL_FORMATS[key](value);
      });
      saveFractalSettings(fractalSettings);
      // fractalPower is always among the four rerolled above, and (see
      // its own dedicated listener just above) is the one slider whose
      // manual drag already triggers a quick re-injection -- mirror
      // that same responsiveness here instead of leaving a stale/
      // possibly-flat view on screen until the next scheduled wrap.
      if (activeReinject) activeReinject(performance.now(), 1200);
    }

    // Timer lives in this (buildFractal's own) closure, same pattern as
    // the camera roll's own shuffle timer just above -- built once,
    // persists across fractal opens/closes, and is a no-op whenever
    // nothing is listening to activeReinject (i.e. the fractal is
    // closed), since randomizeFractalSettings only ever no-ops that one
    // call in that case.
    let randomizerTimerHandle = null;
    function stopRandomizerTimer() {
      if (randomizerTimerHandle) clearInterval(randomizerTimerHandle);
      randomizerTimerHandle = null;
    }
    function startRandomizerTimer() {
      stopRandomizerTimer();
      if (!fractalSettings.randomizerEnabled) return;
      randomizerTimerHandle = setInterval(randomizeFractalSettings, fractalSettings.randomizerTimerSec * 1000);
    }
    settingsPanelStartRandomizerTimer = startRandomizerTimer;
    settingsPanelStopRandomizerTimer = stopRandomizerTimer;

    const randomizerToggle = panel.querySelector('[data-toggle="randomizerEnabled"]');
    randomizerToggle.checked = fractalSettings.randomizerEnabled;
    randomizerToggle.addEventListener("change", (e) => {
      fractalSettings.randomizerEnabled = e.target.checked;
      saveFractalSettings(fractalSettings);
      startRandomizerTimer();
    });

    const randomizerTimerEl = panel.querySelector("[data-randomizer-timer]");
    const randomizerPills = Array.prototype.slice.call(randomizerTimerEl.querySelectorAll(".fractal-controls-randomizer-pill"));
    function updateRandomizerPillStates() {
      randomizerPills.forEach((pill) => {
        pill.classList.toggle("is-active", Number(pill.dataset.randomizerSec) === fractalSettings.randomizerTimerSec);
      });
    }
    updateRandomizerPillStates();
    randomizerPills.forEach((pill) => {
      pill.addEventListener("click", () => {
        fractalSettings.randomizerTimerSec = Number(pill.dataset.randomizerSec);
        saveFractalSettings(fractalSettings);
        updateRandomizerPillStates();
        startRandomizerTimer();
      });
    });

    panel.querySelector("[data-randomize-now]").addEventListener("click", randomizeFractalSettings);

    ["avoidEmptySpaces", "growthEnabled", "ogMode", "lowPerformanceMode"].forEach((key) => {
      const toggle = panel.querySelector('[data-toggle="' + key + '"]');
      toggle.checked = fractalSettings[key];
      toggle.addEventListener("change", (e) => {
        fractalSettings[key] = e.target.checked;
        saveFractalSettings(fractalSettings);
      });
    });

    // Low performance mode has two extra effects beyond the plain
    // setting flip above -- a CSS hook (see fractalize-core.css) that
    // drops the panels' backdrop-filter blur, and an immediate re-
    // resolution via activeResize (resize() itself already reads this
    // setting, see openFractal, but nothing else re-triggers it the
    // moment the checkbox changes -- no resize event, no panel-open
    // transition). Applied once up front too, so a fractal opened with
    // this already turned on (from a previous visit) starts correct
    // rather than waiting for the first resize/panel toggle.
    el.classList.toggle("low-performance", fractalSettings.lowPerformanceMode);
    panel.querySelector('[data-toggle="lowPerformanceMode"]').addEventListener("change", (e) => {
      el.classList.toggle("low-performance", e.target.checked);
      if (activeResize) activeResize();
    });

    wireLiveAudioControls(panel);

    el.querySelector(".image-fractal-close").addEventListener("click", closeFractal);
    // activeCurrentImageSrc (kept in sync by the active session, see
    // startFractalSession/frame() below) must be read BEFORE
    // closeFractal() runs -- that function nulls it out as part of its
    // own teardown.
    el.querySelector(".image-fractal-switch-visualizer").addEventListener("click", () => {
      const src = activeCurrentImageSrc;
      closeFractal();
      if (src) openVisualizer(src);
    });

    const canvas = el.querySelector(".image-fractal-canvas");
    const glOptions = { preserveDrawingBuffer: true };
    const gl = canvas.getContext("webgl", glOptions) || canvas.getContext("experimental-webgl", glOptions);
    let uniforms = null;
    if (gl) {
      const program = gl.createProgram();
      gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
      gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error("Fractal shader program failed to link: " + gl.getProgramInfoLog(program));
      }
      gl.useProgram(program);

      const quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, "aPos");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      uniforms = {
        resolution: gl.getUniformLocation(program, "uResolution"),
        zoom: gl.getUniformLocation(program, "uZoom"),
        c: gl.getUniformLocation(program, "uC"),
        center: gl.getUniformLocation(program, "uCenter"),
        baseColor: gl.getUniformLocation(program, "uBaseColor"),
        image: gl.getUniformLocation(program, "uImage"),
        imageNext: gl.getUniformLocation(program, "uImageNext"),
        imageBlend: gl.getUniformLocation(program, "uImageBlend"),
        maxIter: gl.getUniformLocation(program, "uMaxIter"),
        power: gl.getUniformLocation(program, "uPower"),
        bgSaturation: gl.getUniformLocation(program, "uBgSaturation"),
      };

      // Two identically-configured textures -- see fractalTextureNext's
      // own comment above for why a live switch swaps between them
      // rather than allocating a new one per switch.
      [fractalTexture, fractalTextureNext] = [gl.createTexture(), gl.createTexture()];
      [fractalTexture, fractalTextureNext].forEach((tex) => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      });
    }

    fractalGl = gl;
    fractalUniforms = uniforms;
    return el;
  }

  // GL texture uploads (and buildPixelSampler's own canvas draw below)
  // are cheaper the smaller the source is, and this fractal's chaotic,
  // wildly-tiled UV sampling (see sampleImage in FRAGMENT_SHADER) never
  // benefits from more than a modest source resolution -- individual
  // photo pixels aren't recognizable once they're warped through the
  // escape-time math anyway. Downscaling before the image ever reaches
  // the GPU (or buildPixelSampler) meaningfully cuts both the upload
  // payload and the decode/draw cost that previously landed as a single
  // synchronous hitch on a full-resolution (2000px+) source photo.
  const TEXTURE_MAX_DIM = 900;
  function downscaleForTexture(imgEl, maxDim) {
    const w = imgEl.naturalWidth || imgEl.width;
    const h = imgEl.naturalHeight || imgEl.height;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    if (scale >= 1) return imgEl; // already small enough, skip the extra canvas
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext("2d").drawImage(imgEl, 0, 0, c.width, c.height);
    return c;
  }

  // A tiny offscreen copy of the photo, read into a plain pixel array
  // once, so repeated random sampling (every cycle) is just array math --
  // no repeated canvas readbacks. Also computes the photo's own average
  // color (sampler.average) in the same pass, for the "escaped" region's
  // base color -- see buildFractal()'s FRAGMENT_SHADER comment.
  function buildPixelSampler(imgEl) {
    const size = 48;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    ctx.drawImage(imgEl, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    let rSum = 0, gSum = 0, bSum = 0;
    const pixelCount = size * size;
    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
    }

    const sampler = function (u, v) {
      const x = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
      const y = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
      const i = (y * size + x) * 4;
      return { r: data[i] / 255, g: data[i + 1] / 255, b: data[i + 2] / 255 };
    };
    sampler.average = { r: rSum / pixelCount / 255, g: gSum / pixelCount / 255, b: bSum / pixelCount / 255 };
    return sampler;
  }

  function isFractalOpen() {
    return !!fractalEl && fractalEl.classList.contains("is-open");
  }

  // Cheap CPU-side echo of the shader's own iteration math, used only to
  // score candidate (c, center) pairs before committing to one (see
  // injectFromImage below) -- a handful of these per injection, every
  // few seconds, is trivial compared to doing it per-pixel on the GPU
  // every frame. power must match whatever uPower the shader is actually
  // rendering with (fractalSettings.fractalPower, or 2 for OG Fractal --
  // see frame()) -- scoring against the wrong exponent's shape would
  // validate candidates for a fractal that isn't the one on screen.
  function juliaIterations(zx, zy, cx, cy, maxIter, power) {
    let iter = 0;
    while (iter < maxIter) {
      if (zx * zx + zy * zy > 4) break;
      let rx = zx, ry = zy;
      for (let k = 1; k < power; k++) {
        const nrx = rx * zx - ry * zy;
        const nry = rx * zy + ry * zx;
        rx = nrx;
        ry = nry;
      }
      zx = rx + cx;
      zy = ry + cy;
      iter++;
    }
    return iter;
  }

  // How much escape-time varies across a small grid of sample points
  // around (centerX, centerY) -- near 0 means the whole area is one flat
  // region (all escaping immediately, or none escaping at all); higher
  // means real boundary detail is nearby. Checked at several zoom levels
  // spanning the full range either mode's zoom formula can reach (OG
  // Fractal always 1->7; Smooth mode's zoom depth is now adjustable up
  // to 15x), scored on the worst of them -- a candidate that's only
  // detailed at one zoom can still open (or drift) into an empty field
  // of color at another, which single-zoom scoring couldn't catch.
  const SCORE_ZOOMS = [1, 2, 3.5, 5.5, 8, 11, 15];
  // Low performance mode's own, much cheaper stand-in for the full
  // SCORE_ZOOMS sweep above -- 3 zooms spanning the same low/mid/high
  // range instead of 7, used only by injectFromImage's own scoring
  // (never the watchdog, which already passes its own single-zoom array
  // regardless of this setting). Less thorough validation against a
  // candidate turning out empty at some *other* zoom than the ones
  // checked, but MIN_SCORE/MAX_ATTEMPTS below still apply, so this
  // trades some of that safety margin for a meaningfully cheaper search,
  // not a different search entirely.
  const SCORE_ZOOMS_LOW = [1, 5.5, 15];
  // zooms defaults to the full validated range above; the flatness
  // watchdog in frame() instead passes a single-element array (whatever
  // zoom is actually on screen right now) for a much cheaper live check.
  // aspectRatio must match the shader's own uResolution.x/uResolution.y
  // (see FRAGMENT_SHADER's "p.x *= uResolution.x / uResolution.y") --
  // without it this grid is square regardless of the actual viewport, so
  // on any wide monitor the real rendered frame extends well past what
  // was ever validated, and the unchecked left/right edges are exactly
  // where an "empty space" complaint on a widescreen would come from.
  function scoreJuliaView(cx, cy, centerX, centerY, power, zooms, aspectRatio) {
    const GRID = 6;
    const checkZooms = zooms || SCORE_ZOOMS;
    const aspect = aspectRatio || 1;
    let worst = Infinity;
    for (let z = 0; z < checkZooms.length; z++) {
      const sampleZoom = checkZooms[z];
      let minIter = Infinity;
      let maxIter = -Infinity;
      for (let i = 0; i < GRID; i++) {
        for (let j = 0; j < GRID; j++) {
          const px = ((i / (GRID - 1) - 0.5) * aspect) / sampleZoom + centerX;
          const py = (j / (GRID - 1) - 0.5) / sampleZoom + centerY;
          const it = juliaIterations(px, py, cx, cy, 60, power);
          if (it < minIter) minIter = it;
          if (it > maxIter) maxIter = it;
        }
      }
      worst = Math.min(worst, maxIter - minIter);
    }
    return worst;
  }

  function openFractal(srcOrImgEl, opts) {
    if (!fractalEl) fractalEl = buildFractal();
    fractalCanvasEl = fractalEl.querySelector(".image-fractal-canvas");
    fractalEl.classList.add("is-open");
    if (fractalEl.requestFullscreen) fractalEl.requestFullscreen().catch(() => {});
    lockScroll();
    resetIdleHide();
    // A stream already started elsewhere (the visualizer's own panel, or
    // a host page's setup card -- see syncLiveAudioPanel's own comment)
    // shows correctly here immediately, not just once this panel's own
    // checkbox is toggled.
    syncLiveAudioPanel(fractalEl);

    if (!fractalGl) {
      // WebGL unavailable (very old/restricted browser) -- nothing to
      // render; leave the close button reachable rather than a blank
      // frozen screen.
      return;
    }

    // Whether the opened photo gets auto-added to the persisted
    // imageQueue/localStorage -- default true (matches original
    // behavior). A future caller passing a session-only source (e.g. a
    // blob: URL from an upload) should pass persistQueue:false, since a
    // blob URL is only valid for this page's lifetime and would just
    // fail to load on the next visit's shuffle/camera-roll otherwise.
    const persistQueue = !opts || opts.persistQueue !== false;

    resolveImageSource(srcOrImgEl, (imgEl) => {
      if (!isFractalOpen()) return; // closed again before the image resolved
      startFractalSession(imgEl, persistQueue);
    });
  }

  function startFractalSession(imgEl, persistQueue) {
    const gl = fractalGl;
    const sourceImg = downscaleForTexture(imgEl, TEXTURE_MAX_DIM);
    fractalSamplePixel = buildPixelSampler(sourceImg);
    gl.bindTexture(gl.TEXTURE_2D, fractalTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceImg);
    // fractalTextureNext needs to hold *some* complete, valid image from
    // the start (the shader always samples it, see sampleImage in
    // FRAGMENT_SHADER) even though uImageBlend sits at its "off" value
    // until a switch is mid-crossfade -- reuse the same photo rather
    // than leaving it uninitialized.
    gl.bindTexture(gl.TEXTURE_2D, fractalTextureNext);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceImg);
    // The escaped region's base color (mixed with the photo near the
    // boundary) was previously a fixed purple, unrelated to whatever
    // photo was loaded -- now it's the photo's own average color,
    // darkened to keep some depth/contrast rather than a flat wash.
    // *0.4 (the original value) crushed this to under half the photo's
    // brightness and read as too dark; *0.7 (a later fix) overcorrected
    // once detail got its own saturation/brightness boost, reading as
    // "much too bright and overly saturated" by contrast -- *0.55 is a
    // middle point between those two complaints. Also compensated via
    // the live "Background saturation" slider (bgSaturationPct, applied
    // in FRAGMENT_SHADER, not here) for saturation specifically -- this
    // multiplier is the value/brightness half of that same balance.
    // let, not const: during a live image-switch crossfade this lerps
    // toward nextAvg frame-by-frame (see frame() below) instead of
    // jumping the instant the new texture is bound -- the uniform itself
    // is now set every frame in frame(), not once here.
    let currentAvg = fractalSamplePixel.average;
    let nextAvg = null;

    // getAttribute, not the .src property -- the property resolves to a
    // full absolute URL, while fractalSettings.imageQueue (and the host
    // page's photo catalog) store the same relative "folder+filename"
    // strings a gallery-style host assigns, so comparing against the
    // resolved property would never match and the queue/badge logic
    // below would silently never recognize the currently-open photo as
    // already queued. A src string passed directly (not an <img>) has
    // no such attribute/property distinction -- imgEl.src is exactly
    // what was assigned in that case.
    let currentImageSrc = imgEl.getAttribute ? imgEl.getAttribute("src") || imgEl.src : imgEl.src;
    if (persistQueue && fractalSettings.imageQueue.indexOf(currentImageSrc) === -1) {
      fractalSettings.imageQueue.push(currentImageSrc);
      saveFractalSettings(fractalSettings);
    }
    activeCurrentImageSrc = currentImageSrc;
    if (cameraRollRefreshBadges) cameraRollRefreshBadges();
    if (fractalSettings.shuffleEnabled && cameraRollStartShuffleTimer) cameraRollStartShuffleTimer();
    if (fractalSettings.randomizerEnabled && settingsPanelStartRandomizerTimer) settingsPanelStartRandomizerTimer();

    let cCurrent = { x: 0.3, y: 0.4 };
    let cTarget = { x: 0.3, y: 0.4 };
    let cFrom = { x: 0.3, y: 0.4 };
    let centerCurrent = { x: 0.15, y: 0.2 };
    let centerTarget = { x: 0.15, y: 0.2 };
    let centerFrom = { x: 0.15, y: 0.2 };
    let injectStart = 0;
    // Spans almost the whole cycle (not a short blend that then sits
    // frozen while only zoom keeps changing) so c/center are always
    // drifting, never static -- covering the same distance over ~3.6x
    // longer also reads as a slower, gentler drift rather than a snap.
    const INJECT_BLEND_MS = MANDELBROT_CYCLE_MS * 0.9;
    let injectBlendMs = INJECT_BLEND_MS;
    // False only before the very first injection (whose "current
    // position" is still the hardcoded, unvalidated {0.3, 0.4} default
    // below, not a real anchor) -- see injectFromImage's own comment on
    // why every later call anchors its search near cTarget instead of
    // searching the whole shell from scratch.
    let hasValidAnchor = false;

    // "Smooth" mode: defaults to the same proven zoom ceiling as OG
    // Fractal (7x, now adjustable via the zoom depth slider) -- going
    // much deeper is what broke the earlier settings-panel attempt,
    // since the photo-derived c-value heuristic stops reliably finding
    // real detail well before 150x+ ever needed to worry about it --
    // but stretched across an adjustable, longer-than-OG cycle for
    // slower exploration, and the transition to a new photo-derived
    // subject is a zoom-out-and-back-in "morph" spanning the *whole*
    // cycle (see frame() below) rather than a hard reset back to
    // zoom=1: radial motion, matching how a fractal viewer naturally
    // moves, rather than the lateral pan a plain c/center drift
    // produces while still zoomed in. c/center are always blending
    // toward the target across the same span, so the fractal itself
    // keeps morphing continuously -- the moment it stops changing is
    // exactly when it starts reading as "frozen" rather than "alive."

    function injectFromImage(now, blendMs) {
      // Most (c, center) combinations give a "boring" view -- either
      // everything escapes immediately or nothing does, both flat --
      // regardless of which shell/heuristic picked them. Rather than
      // accept whatever the first random pixel gives, sample candidate
      // pixels and keep whichever actually shows escape-time variance
      // nearby (scoreJuliaView above), i.e. real boundary detail to zoom
      // into. Still entirely image-derived, just the best of several
      // tries instead of the first one -- and instead of a fixed small
      // batch, keeps trying (up to a cap) until one clears a "not flat"
      // bar, so a genuinely empty field of color takes a run of bad luck
      // across dozens of attempts to slip through, not just six.
      // Raised from 10: sampling actual gallery photos showed most random
      // candidates score 0 (completely flat) and only a small tail finds
      // real detail -- 10 let the loop settle for the first candidate to
      // barely clear a low bar instead of continuing toward one of the
      // richer candidates most photos do reach within the attempt budget.
      const MIN_SCORE = 20;
      // Raised from the original 40 after live reports of sustained
      // flatness at fractalPower 4 -- the real fix for *that* turned
      // out to be decoupling angle from the photo's hue (see above),
      // since a photo's hue palette could make the sparse good angular
      // windows literally unreachable no matter the attempt count. 150
      // remains as a comfortable safety margin now that a uniformly
      // random angle can actually reach every window -- cost stays
      // negligible either way, this only runs a few times per minute,
      // not per frame. Low performance mode halves it (and, below,
      // scores against 3 zooms instead of 7) -- this loop is the single
      // biggest CPU cost in the whole file, so a slow machine hitting
      // its worst case (never clearing MIN_SCORE) is exactly what a
      // choppy cycle-wrap/RANDOMIZE NOW/Fractal-shape-drag looks like.
      const MAX_ATTEMPTS = fractalSettings.lowPerformanceMode ? 75 : 150;
      const scoreZooms = fractalSettings.lowPerformanceMode ? SCORE_ZOOMS_LOW : SCORE_ZOOMS;
      // OG Fractal always scores/renders at power 2, ignoring the
      // "Fractal shape" slider -- matches its own "exact original
      // behavior" invariant, same as every other Smooth-mode-only
      // setting.
      const scoringPower = fractalSettings.ogMode ? 2 : fractalSettings.fractalPower;
      // Widescreen/ultrawide monitors render a much wider horizontal
      // slice of the complex plane than a square viewport would (see
      // scoreJuliaView's own comment) -- read fresh each injection
      // rather than cached, since a visitor can resize the window
      // between cycles.
      const aspectRatio = window.innerWidth / window.innerHeight;
      let best = null;
      // Angle and radius are random within a shell, no longer derived
      // from a sampled pixel's hue/brightness. That photo-coupled
      // version (angle from atan2(R,G), radius nudged by brightness
      // within 0.65-0.9) was the original design and seemed reasonable,
      // but live-instrumented testing at fractalPower 4 exposed why it
      // can fail hard: at a fixed radius, the "good" (non-flat) angles
      // cluster in narrow ~10-15 degree windows repeating with the
      // fractal's own N-fold rotational symmetry, separated by long dead
      // stretches scoring exactly 0 -- and a photo's actual hue palette
      // is often concentrated in a much narrower range than a full 360
      // degrees, so tying angle to hue could make those good windows
      // literally unreachable for that photo, no matter how many
      // attempts. Radius has the same problem one level deeper: even
      // within the old 0.65-0.9 band, direct sampling found most
      // specific radii there score poorly at power 4, with only a
      // narrow real island near 0.80 that shifts with power -- so
      // hardcoding one power's island would just move today's problem
      // to a different power.
      //
      // Full-shell random search (0.3-1.4 radius, any angle) fixed
      // *finding* a good candidate reliably, but exposed a second,
      // deeper bug: the blend from wherever the view currently is
      // toward a brand new, unrelated random target was flat 70-90%+ of
      // its own length in direct measurement, because two random good
      // islands are usually far apart with nothing but dead territory
      // between them. Shortening the blend to avoid that path (a
      // version that shipped briefly) fixed the flatness but read as
      // choppy -- "moving... then zooming in only... then moving
      // again" -- reintroducing the frozen-feeling stop-start rhythm
      // this whole mode was designed to avoid.
      //
      // Fix: every injection *after* the first anchors its search near
      // cTarget (the current or just-reached position) instead of the
      // whole shell -- a short hop to a nearby good window rather than
      // a teleport to a random distant one. Measured directly: a
      // Cartesian blend between two independently-random good
      // candidates was flat ~69% of its length on average; anchored to
      // a +/-20 degree, +/-0.12 radius hop from a known-good point, that
      // dropped to ~20%, while still finding a candidate within the
      // narrow window 100% of the time (0 failures across 75 trials
      // spanning every power 2-6). Good enough to restore a long,
      // continuous blend (see INJECT_BLEND_MS-length blends below)
      // without reintroducing the original sustained-flatness bug.
      const HOP_RANGE_RAD = (20 * Math.PI) / 180;
      const HOP_RANGE_RADIUS = 0.12;
      let anchorAngle = null;
      let anchorRadius = null;
      if (hasValidAnchor) {
        anchorAngle = Math.atan2(cTarget.y, cTarget.x);
        anchorRadius = Math.sqrt(cTarget.x * cTarget.x + cTarget.y * cTarget.y);
      }
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let angle, radius;
        if (anchorAngle !== null) {
          angle = anchorAngle + (Math.random() * 2 - 1) * HOP_RANGE_RAD;
          radius = Math.max(0.3, Math.min(1.4, anchorRadius + (Math.random() * 2 - 1) * HOP_RANGE_RADIUS));
        } else {
          // Only the very first injection ever (see hasValidAnchor) --
          // no real position to hop from yet, so search the whole shell.
          angle = Math.random() * Math.PI * 2;
          radius = 0.3 + Math.random() * 1.1;
        }
        const c = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
        // Zooming in on a fixed point (e.g. the origin) often lands on a
        // featureless stretch for an arbitrary c -- the richest boundary
        // detail tends to cluster near the value of c itself (c is the
        // orbit of the critical point z=0 after one step), so the zoom
        // target rides along with c instead of staying put.
        const center = { x: c.x * 0.5, y: c.y * 0.5 };
        const score = scoreJuliaView(c.x, c.y, center.x, center.y, scoringPower, scoreZooms, aspectRatio);
        if (!best || score > best.score) best = { c, center, score };
        if (best.score >= MIN_SCORE) break;
      }
      cFrom = cCurrent;
      cTarget = best.c;
      centerFrom = centerCurrent;
      centerTarget = best.center;
      injectStart = now;
      injectBlendMs = blendMs || INJECT_BLEND_MS;
      hasValidAnchor = true;
    }
    activeReinject = injectFromImage;

    // let, not const: the "Avoid empty spaces" watchdog's fallback tier
    // fast-forwards this to skip ahead to the next cycle rather than
    // doing a side-channel re-injection -- see that block in frame().
    let startTime = performance.now();
    injectFromImage(startTime);
    // The hardcoded {0.3, 0.4} default above isn't photo-derived or
    // scored -- it's just a starting point for cFrom/centerFrom to blend
    // away from. Blending the first cycle away from it wasted the
    // opening seconds on that unvalidated view instead of the one
    // scoring just picked, which is exactly the "empty field of color"
    // this scoring pass is meant to avoid. Only the very first cycle
    // needs this snap; every later injectFromImage call blends from
    // wherever the view already is, which is always itself a scored,
    // detailed position.
    cCurrent = cTarget;
    centerCurrent = centerTarget;
    cFrom = cTarget;
    centerFrom = centerTarget;
    let lastCyclePhase = 0;
    // Reactivity smoothing state (see reactivitySmoothingPct's own
    // comment and the smoothing math in frame() below) -- starts at 0
    // rather than whatever a previous session left off at, so a fresh
    // open never opens mid-swing on a stale value.
    let smoothedPulse = 0;
    // "Avoid empty spaces" watchdog state (Smooth mode only) -- see its
    // check in frame() below for why this exists alongside
    // MIN_SCORE-validated injection rather than instead of it.
    let flatSince = null;
    let lastFlatCheck = 0;
    // null = no escape dive in progress; else the timestamp it started,
    // used both to drive the zoom boost each frame and to know when to
    // escalate to a wind-down if the dive alone didn't help.
    let escapeBoostStart = null;
    // null = no wind-down in progress; else the timestamp it started.
    // windDownFromZoom is the natural (unboosted) zoom value at that
    // instant, captured once so the ease-to-1 has a fixed start point
    // to interpolate from -- see the wind-down's own comment in frame().
    let windDownStart = null;
    let windDownFromZoom = 1;

    // Live image-switch state (camera roll "play now" / shuffle) -- see
    // requestImageSwitch and its frame() integration below.
    let switchRequested = null; // pending target src, or null
    let switchLoadedImg = null; // the downscaled source for switchRequested, once ready (see downscaleForTexture)
    let switchLoadedSampler = null; // buildPixelSampler(switchLoadedImg), precomputed alongside it
    // Once switchLoadedImg is ready, the crossfade begins immediately,
    // right on top of whatever the fractal is already doing -- no zoom
    // freeze needed. Both textures are sampled at the exact same
    // iterated UV (sampleImage in FRAGMENT_SHADER), so a crossfade reads
    // as the *same* fractal shape's colors dissolving from one photo to
    // the other while it keeps zooming/drifting, not a scene cut. An
    // earlier version eased zoom down to 1x, hard-swapped the texture,
    // then eased back in -- replaced because the user explicitly wanted
    // to actually *see* the two photos' fractals blending together, not
    // a freeze-swap-unfreeze.
    let crossfadeStart = null;
    const IMAGE_CROSSFADE_MS = 1600;
    // Must match sampleImage's own hardcoded `band` in FRAGMENT_SHADER --
    // see that function's comment for what this controls.
    const IMAGE_REVEAL_BAND = 0.3;

    // Preload the new photo; every gallery photo is already preloaded
    // site-wide (a gallery-style host's own preload() calls), so in
    // practice this resolves near-instantly from cache. img.decode()
    // (falling back to the onload event on very old browsers) resolves
    // once the browser has decoded the image off the main thread, so the
    // (synchronous, but now cheap since decode is already done)
    // downscale-canvas draw and GPU upload that follow don't land as a
    // single blocking hitch inside the render loop -- all of this now
    // happens here, once, off frame()'s hot path, so frame() only has
    // to flip a couple of numbers to start the reveal once it resolves.
    function requestImageSwitch(newSrc) {
      // Also rejects a new target while one is already mid-flight
      // (loading OR crossfading), not just an exact repeat -- letting a
      // second request interrupt an in-progress crossfade would either
      // desync currentImageSrc from whichever texture actually finishes
      // uploading first, or force a visible snap back to "fully old
      // photo" to restart cleanly. Simplest correct behavior: one switch
      // completes before the next one can begin. The 1.6s window this
      // could ever matter in is far shorter than the shuffle timer's
      // 10s floor, so this only ever bites a deliberate rapid double-
      // click, not shuffle's own pacing.
      if (newSrc === currentImageSrc || switchRequested !== null) return;
      switchRequested = newSrc;
      switchLoadedImg = null;
      switchLoadedSampler = null;
      const img = new Image();
      // See resolveImageSource's own comment on why this is needed for
      // a cross-origin source to ever be readable via canvas below.
      img.crossOrigin = "anonymous";
      img.src = newSrc;
      const ready = img.decode
        ? img.decode().catch(() => {})
        : new Promise((resolve) => {
            img.onload = resolve;
            img.onerror = resolve;
          });
      ready.then(() => {
        if (switchRequested !== newSrc) return; // superseded by a later switch/shuffle tick
        const source = downscaleForTexture(img, TEXTURE_MAX_DIM);
        gl.bindTexture(gl.TEXTURE_2D, fractalTextureNext);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        switchLoadedSampler = buildPixelSampler(source);
        switchLoadedImg = source;
      });
    }
    activeImageSwitch = requestImageSwitch;

    // Downscales the canvas's backing resolution while a settings/
    // camera-roll panel is open. The canvas is still visible (and, for
    // the camera roll specifically, actively crossfading -- switches
    // are triggered from inside that panel) behind the panel's glass,
    // but rendering at full device-pixel-ratio resolution underneath a
    // continuously-animating full-bleed backdrop-filter blur is
    // expensive on both counts: it's more pixels for the fractal shader
    // itself to fill, AND more pixels for the blur to recompute every
    // single frame (the blur operates on this same composited buffer,
    // at its native resolution). A visitor looking at the panel isn't
    // examining canvas sharpness through blurred glass, so this is a
    // real perf win with no noticeable visual cost while it's active.
    function resize() {
      const panelOpen = fractalEl.classList.contains("panel-open");
      // Low performance mode always renders at 1x, same as the
      // panel-open downscale above and for the same reason -- fewer
      // pixels for the shader to fill every frame, which on a high-DPR
      // display (2x = 4x the pixels) is one of the largest single levers
      // on frame rate available here.
      const dpr = panelOpen || fractalSettings.lowPerformanceMode ? 1 : Math.min(window.devicePixelRatio || 1, 2);
      fractalCanvasEl.width = window.innerWidth * dpr;
      fractalCanvasEl.height = window.innerHeight * dpr;
      gl.viewport(0, 0, fractalCanvasEl.width, fractalCanvasEl.height);
    }
    resize();
    window.addEventListener("resize", resize);
    activeResize = resize;
    // Tracked so frame() only calls resize() on an actual open/close
    // transition (a DOM read + GL resize every single frame would waste
    // back the very perf this exists to save), not every frame.
    let lastPanelOpenForResize = fractalEl.classList.contains("panel-open");

    function frame(now) {
      if (!isFractalOpen()) {
        window.removeEventListener("resize", resize);
        return;
      }
      const panelOpen = fractalEl.classList.contains("panel-open");
      if (panelOpen !== lastPanelOpenForResize) {
        lastPanelOpenForResize = panelOpen;
        resize();
      }
      // "Avoid empty spaces" tuning -- see the watchdog block below (and
      // its escape-boost application right after zoom is computed) for
      // how these are used together.
      const FLAT_SCORE_THRESHOLD = 15;
      const FLAT_TOLERANCE_MS = 1000; // how long a flat reading must persist before the first response (the dive)
      const ZOOM_DIVE_RAMP_MS = 1800; // duration of the dive's smooth zoom-in bump
      const ZOOM_DIVE_BOOST_MAX = 3; // peak multiplier added on top of 1x, i.e. up to 4x zoom at the peak of the bump
      const DIVE_GRACE_MS = ZOOM_DIVE_RAMP_MS + 500; // grace period after the dive to see if it resolved things, before winding down
      const WIND_DOWN_MS = 1400; // duration of the ease-back-to-1x before skipping ahead to the next cycle
      let zoom;
      // Halved under low performance mode -- this is a per-pixel,
      // per-frame cost across the whole canvas, so it's one of the most
      // direct levers on frame rate a slower GPU actually has.
      let maxIter = fractalSettings.lowPerformanceMode ? 60 : 120;
      if (fractalSettings.ogMode) {
        // Exactly the original behavior: one 6s cycle, zoom climbs
        // 1 -> 7 across the whole thing, then wraps straight back --
        // preserved verbatim as a selectable option, deaf to every
        // slider below (they all live on fractalSettings, but nothing
        // in this branch reads them).
        const cyclePhase = ((now - startTime) % MANDELBROT_CYCLE_MS) / MANDELBROT_CYCLE_MS;
        if (cyclePhase < lastCyclePhase) injectFromImage(now);
        lastCyclePhase = cyclePhase;
        zoom = 1 + Math.pow(cyclePhase, 1.5) * 6;
      } else {
        // No static "hold" at the ceiling -- that's exactly what froze
        // for ~15s of every 20s cycle (zoom pinned at 7 *and* no
        // injection running, since the previous version only injected
        // while entering/leaving a brief dip at the seam). Zoom eases
        // from 1 up to the depth setting and back down to 1, symmetric
        // around the wrap (cyclePhase 0 == 1, so there's still no jump
        // at the seam), and c/center blend continuously across nearly
        // the entire cycle -- same principle as OG Fractal's own "blend
        // spans (almost) the whole cycle so nothing ever sits still,"
        // just stretched across an adjustable cycle length.
        //
        // A short-blend-then-hold version of this shipped briefly (c/
        // center blend quickly, then sit still while only zoom moved)
        // specifically to dodge a *different* bug -- see
        // injectFromImage's own comment on why the blend path itself
        // needed fixing at fractalPower 4 -- but user feedback caught
        // that the hold read as choppy: "moving... then zooming in
        // only... then moving again," reintroducing the frozen-feeling
        // stop-start rhythm this mode was designed to avoid in the
        // first place. Restored the long continuous blend now that
        // injectFromImage's anchored search (short hops to a nearby
        // good window instead of teleporting to a random distant one)
        // keeps the blend path itself validated enough to make a long,
        // continuous drift viable again.
        const cycleDurationMs = fractalSettings.cycleDurationSec * 1000;
        // Reactivity smoothing: an exponential moving average over the
        // raw analyser reading, same idea as a VU meter's ballistics --
        // 0% retains none of the previous frame (identical to the
        // original un-smoothed behavior), higher values blend in more of
        // it each frame, turning an instant, jittery reading into a
        // slower, steadier rise and fall. 0.95 as the retain ceiling
        // (not 1.0) so even "100%" still tracks a sustained volume
        // change within roughly a second rather than never actually
        // catching up.
        const retain = (fractalSettings.reactivitySmoothingPct / 100) * 0.95;
        smoothedPulse += (computePulse() - smoothedPulse) * (1 - retain);
        const pulse = smoothedPulse;

        const cyclePhase = ((now - startTime) % cycleDurationMs) / cycleDurationMs;
        if (cyclePhase < lastCyclePhase) injectFromImage(now, cycleDurationMs * 0.98);
        lastCyclePhase = cyclePhase;

        const distFromWrap = Math.min(cyclePhase, 1 - cyclePhase); // 0 at the wrap, 0.5 at the cycle's midpoint (peak zoom)
        const morphPhase = distFromWrap * 2; // 0 at the wrap, 1 at the midpoint
        // 1.5 is the same fixed exponent OG Fractal itself uses --
        // reactivity=0 (the default, matching "this didn't exist
        // before") leaves it exactly there; higher reactivity lets the
        // music pulse wobble it, speeding up/easing off how eagerly
        // the dive accelerates.
        const diveExponent = 1.5 + pulse * (fractalSettings.musicReactivityPct / 100) * 0.6;
        zoom = 1 + Math.pow(morphPhase, diveExponent) * (fractalSettings.zoomDepth - 1);

        if (fractalSettings.growthEnabled) {
          maxIter = fractalSettings.lowPerformanceMode ? 50 + pulse * 25 : 100 + pulse * 50;
        }
      }
      // Escape-dive zoom boost, applied every frame (not just on the
      // periodic check below) so it renders as one continuous smooth
      // zoom-in rather than a step -- see the watchdog block below for
      // what starts/stops escapeBoostStart. A temporary multiplicative
      // bump on top of the cycle's own zoom, using the SAME c/center
      // (no blend, no new unvalidated path) -- "inject a layer lower":
      // a fractal boundary has detail at every scale near any point
      // that scored well at all, so a flat reading at this exact instant
      // usually just means we're passing through a locally smooth patch
      // at this particular zoom, not that the candidate itself is bad.
      // If the dive alone doesn't clear it, a wind-down phase eases zoom
      // smoothly back to 1x (c/center held fixed the whole time -- see
      // the watchdog block below for why) before skipping ahead, instead
      // of jumping straight from whatever zoom the cycle was naturally
      // at down to 1x in a single frame.
      // Live image-switch crossfade -- see requestImageSwitch above,
      // which already did the decode/downscale/GPU-upload/sampling work
      // asynchronously; frame() just watches for that to resolve. Unlike
      // zoom/c-center, this doesn't need to pre-empt anything: both
      // textures sample the exact same iterated UV (sampleImage in
      // FRAGMENT_SHADER), so the fractal's own shape/zoom/drift keeps
      // running completely normally throughout, and only the photo
      // colors reveal from one to the other. imageBlend (the raw sweep
      // value the shader consumes, see sampleImage/uImageBlend's own
      // comments) and bgBlend (a plain 0-1 progress for the flat
      // background-color lerp near the bottom of this function, which
      // has no per-pixel "depth" to sweep across) both derive from the
      // same eased cfT.
      let imageBlend = -IMAGE_REVEAL_BAND;
      let bgBlend = 0;
      if (switchRequested !== null) {
        if (crossfadeStart === null && switchLoadedImg !== null) {
          crossfadeStart = now;
          nextAvg = switchLoadedSampler.average;
        }
        if (crossfadeStart !== null) {
          const cfT = Math.min(1, (now - crossfadeStart) / IMAGE_CROSSFADE_MS);
          bgBlend = Math.sin((cfT * Math.PI) / 2); // ease-out, matches this file's other transitions
          imageBlend = -IMAGE_REVEAL_BAND + (1 + 2 * IMAGE_REVEAL_BAND) * bgBlend;
          if (cfT >= 1) {
            // Crossfade complete -- swap which GL texture object is
            // "current" (cheap: just relabels two already-uploaded
            // textures, see fractalTextureNext's own comment) rather
            // than re-uploading, and settle every other piece of
            // switch-related state.
            const swapTex = fractalTexture;
            fractalTexture = fractalTextureNext;
            fractalTextureNext = swapTex;
            fractalSamplePixel = switchLoadedSampler;
            currentAvg = nextAvg;
            nextAvg = null;
            currentImageSrc = switchRequested;
            activeCurrentImageSrc = currentImageSrc;
            if (cameraRollRefreshBadges) cameraRollRefreshBadges();
            switchRequested = null;
            switchLoadedImg = null;
            switchLoadedSampler = null;
            crossfadeStart = null;
            imageBlend = -IMAGE_REVEAL_BAND;
            bgBlend = 0;
          }
        }
        // else: still waiting on the new image to finish loading -- the
        // crossfade starts the moment it's ready, checked again next frame.
      }
      if (fractalSettings.avoidEmptySpaces && !fractalSettings.ogMode) {
        if (escapeBoostStart !== null) {
          // Rises fast then HOLDS at peak boost for the rest of the dive,
          // rather than a symmetric bump that peaks once and immediately
          // fades -- a live-instrumented test caught a validated
          // candidate sitting flat for ~6s before the old symmetric dive
          // happened to cross back into good territory on its way down.
          // Spending most of the dive's duration at full boost (not just
          // an instant) gives it far more time actually searching deeper
          // zoom for detail instead of searching for a fraction of a
          // second and then giving back the depth it just gained.
          const DIVE_RISE_FRACTION = 0.3;
          const escapeT = Math.min(1, (now - escapeBoostStart) / ZOOM_DIVE_RAMP_MS);
          const riseT = Math.min(1, escapeT / DIVE_RISE_FRACTION);
          const boostAmount = Math.sin((riseT * Math.PI) / 2); // ease-out rise to 1, then holds at 1
          zoom *= 1 + ZOOM_DIVE_BOOST_MAX * boostAmount;
        } else if (windDownStart !== null) {
          const windT = Math.min(1, (now - windDownStart) / WIND_DOWN_MS);
          const eased = Math.sin((windT * Math.PI) / 2); // ease-out: fast start, gentle settle at 1x
          zoom = windDownFromZoom + (1 - windDownFromZoom) * eased;
        }
      }
      // Read live every frame (not captured once) so dragging the
      // "Fractal shape" slider takes effect immediately -- OG Fractal
      // always renders (and, via scoringPower in injectFromImage, always
      // scores candidates) at power 2, matching its own verbatim
      // invariant.
      const power = fractalSettings.ogMode ? 2 : fractalSettings.fractalPower;
      // 1.0 for OG Fractal (its own original, unadjusted background) --
      // same verbatim-invariant pattern as power above.
      const bgSaturation = fractalSettings.ogMode ? 1.0 : fractalSettings.bgSaturationPct / 100;

      const blend = Math.min(1, (now - injectStart) / injectBlendMs);
      cCurrent = { x: cFrom.x + (cTarget.x - cFrom.x) * blend, y: cFrom.y + (cTarget.y - cFrom.y) * blend };
      centerCurrent = {
        x: centerFrom.x + (centerTarget.x - centerFrom.x) * blend,
        y: centerFrom.y + (centerTarget.y - centerFrom.y) * blend,
      };

      // "Avoid empty spaces" watchdog (Smooth mode only -- OG Fractal is
      // untouched, per its verbatim invariant; also off entirely if the
      // user unchecks the panel toggle, since some genuinely like the
      // raw effect). A candidate is validated only *at the target*
      // injectFromImage picked -- the path to get there (or the current
      // cycle's own zoom sweep through it) isn't itself validated, and
      // complex parameter space isn't convex, so even a good candidate
      // can pass through flat/boring territory. Checked periodically
      // (not every frame -- real cost) against whatever's actually on
      // screen right now.
      //
      // First version of this watchdog just re-blended straight to a
      // brand new c/center on any sustained flat reading, and (after
      // user feedback that the correction itself looked "too snappy")
      // was slowed to a 5000ms blend for smoothness -- which backfired:
      // a real recording showed ~12s of continuous flat/empty screen,
      // because that blend path was *also* never validated, so a longer
      // blend just meant more time possibly still transiting flat
      // territory before landing on the new target. Second version
      // fast-forwarded startTime straight to the next wrap to fix that,
      // which fixed the *desync* between c/center and zoom but not a
      // remaining discontinuity: zoom itself jumped instantly from
      // whatever the cycle naturally had it at (often mid-range, not
      // near 1) straight down to 1 in a single frame the moment the jump
      // landed -- user feedback: still not quite right, and asked for a
      // smooth recenter/fold instead of a snap. Three-tier response now:
      //   1. Fast zoom-DIVE on the *current* candidate ("inject a layer
      //      lower") -- cheap and safe, c/center never change so there's
      //      no new unvalidated path. A fractal boundary has detail at
      //      every scale near any point that scored well to begin with,
      //      so a flat reading at this exact zoom usually just means
      //      this instant is a locally smooth patch, not a bad candidate.
      //   2. If the dive alone doesn't clear it within DIVE_GRACE_MS,
      //      WIND DOWN: ease zoom smoothly back to 1x over WIND_DOWN_MS
      //      (c/center held perfectly still throughout -- blending them
      //      while still zoomed in is exactly the lateral-pan artifact
      //      this project moved away from long ago, see the "Smooth
      //      mode" design notes above injectFromImage; recentering must
      //      happen at low zoom, once we actually reach it, not while
      //      winding down to it).
      //   3. Only once wind-down completes (zoom has actually eased down
      //      to ~1x, not jumped there) does it fast-forward startTime so
      //      the ordinary wrap-detection above fires on the next frame --
      //      same mechanism/blend every normal cycle transition already
      //      uses, and by now imperceptible since zoom is already at the
      //      value that transition expects to start from.
      if (!panelOpen && fractalSettings.avoidEmptySpaces && !fractalSettings.ogMode) {
        if (now - lastFlatCheck > 500) {
          lastFlatCheck = now;
          const liveScore = scoreJuliaView(cCurrent.x, cCurrent.y, centerCurrent.x, centerCurrent.y, power, [zoom], window.innerWidth / window.innerHeight);
          if (liveScore < FLAT_SCORE_THRESHOLD) {
            if (flatSince === null) flatSince = now;
            if (windDownStart !== null) {
              if (now - windDownStart > WIND_DOWN_MS) {
                startTime = now;
                windDownStart = null;
                flatSince = null;
              }
            } else if (escapeBoostStart !== null) {
              if (now - escapeBoostStart > DIVE_GRACE_MS) {
                windDownFromZoom = zoom;
                windDownStart = now;
                escapeBoostStart = null;
              }
            } else if (now - flatSince > FLAT_TOLERANCE_MS) {
              escapeBoostStart = now;
            }
          } else {
            // Resolved -- by the dive, the wind-down, the natural cycle,
            // or the initial reading never having been flat to begin
            // with.
            flatSince = null;
            escapeBoostStart = null;
            windDownStart = null;
          }
        }
      }

      // Base color lerps toward the incoming photo's own average right
      // alongside the texture crossfade above, at the same imageBlend --
      // otherwise the escaped/background region would still show the
      // outgoing photo's color for the entire crossfade and only jump to
      // the new one at the very end, undercutting the "two photos
      // blending together" effect everywhere except the detail itself.
      const effAvg =
        nextAvg === null
          ? currentAvg
          : {
              r: currentAvg.r + (nextAvg.r - currentAvg.r) * bgBlend,
              g: currentAvg.g + (nextAvg.g - currentAvg.g) * bgBlend,
              b: currentAvg.b + (nextAvg.b - currentAvg.b) * bgBlend,
            };

      gl.uniform2f(fractalUniforms.resolution, fractalCanvasEl.width, fractalCanvasEl.height);
      gl.uniform1f(fractalUniforms.zoom, zoom);
      gl.uniform2f(fractalUniforms.c, cCurrent.x, cCurrent.y);
      gl.uniform2f(fractalUniforms.center, centerCurrent.x, centerCurrent.y);
      gl.uniform3f(fractalUniforms.baseColor, effAvg.r * 0.55, effAvg.g * 0.55, effAvg.b * 0.55);
      gl.uniform1f(fractalUniforms.maxIter, maxIter);
      gl.uniform1f(fractalUniforms.power, power);
      gl.uniform1f(fractalUniforms.bgSaturation, bgSaturation);
      gl.uniform1f(fractalUniforms.imageBlend, imageBlend);
      gl.uniform1i(fractalUniforms.image, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fractalTexture);
      gl.uniform1i(fractalUniforms.imageNext, 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fractalTextureNext);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      fractalRAF = requestAnimationFrame(frame);
    }
    fractalRAF = requestAnimationFrame(frame);
  }

  function closeFractal() {
    if (!isFractalOpen()) return;
    fractalEl.classList.remove("is-open");
    cancelAnimationFrame(fractalRAF);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    unlockScrollIfNeeded();
    activeReinject = null;
    activeImageSwitch = null;
    activeResize = null;
    activeCurrentImageSrc = null;
    if (cameraRollStopShuffleTimer) cameraRollStopShuffleTimer();
    if (settingsPanelStopRandomizerTimer) settingsPanelStopRandomizerTimer();
    // Stop capturing the moment the view closes -- no stray mic indicator
    // lingering after the visitor leaves. Resets every live-audio panel
    // on the page, not just this one (see disableLiveAudio's own
    // comment) -- unless the host page opted out via
    // setKeepLiveAudioOnClose (see that flag's own comment).
    if (!keepLiveAudioOnClose) disableLiveAudio();
    fractalEl.classList.remove("chrome-hidden");
    clearIdleHide();
  }

  // Idle-hide: fades out whichever overlay's own top-level chrome
  // buttons (and hides the OS cursor -- see fractalize-core.css) after
  // IDLE_HIDE_MS of no mouse/keyboard activity, for leaving either view
  // running fullscreen on an idle second monitor without stray buttons
  // sitting over the image. Paused entirely while a settings/camera-roll
  // panel is open, checked at fire time rather than schedule time, so
  // opening a panel after the timer's already ticking still holds it
  // off. A single set of always-attached, state-guarded document
  // listeners (same pattern as the fullscreenchange/keydown listeners
  // below) rather than per-open wiring, since only one overlay can be
  // open at a time anyway.
  const IDLE_HIDE_MS = 10000;
  let idleHideTimer = null;

  function activeOverlayEl() {
    if (isFractalOpen()) return fractalEl;
    if (isVisualizerOpen()) return visualizerEl;
    return null;
  }

  function isActiveOverlayPanelOpen() {
    if (isFractalOpen()) return fractalEl.classList.contains("panel-open");
    if (isVisualizerOpen()) {
      const panel = visualizerEl.querySelector(".visualizer-controls");
      return !!panel && panel.classList.contains("is-open");
    }
    return false;
  }

  function clearIdleHide() {
    clearTimeout(idleHideTimer);
    idleHideTimer = null;
  }

  function scheduleIdleHide() {
    clearTimeout(idleHideTimer);
    idleHideTimer = setTimeout(() => {
      const el = activeOverlayEl();
      if (!el || isActiveOverlayPanelOpen()) return;
      el.classList.add("chrome-hidden");
    }, IDLE_HIDE_MS);
  }

  // Called on open (chrome starts visible, timer starts fresh) and on
  // every activity event below (chrome comes back, timer restarts).
  function resetIdleHide() {
    const el = activeOverlayEl();
    if (el) el.classList.remove("chrome-hidden");
    scheduleIdleHide();
  }

  ["mousemove", "mousedown", "touchstart", "keydown"].forEach((type) => {
    document.addEventListener(
      type,
      () => {
        if (activeOverlayEl()) resetIdleHide();
      },
      type === "touchstart" ? { passive: true } : false
    );
  });

  // Covers the case where the visitor exits fullscreen through the
  // browser's own UI/shortcut rather than the close button here. Fully
  // self-contained (only ever touches this file's own state), unlike the
  // keydown handling below, which needs a host page's own awareness of
  // whatever else it might be layered inside (a lightbox, say).
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && isVisualizerOpen()) closeVisualizer();
    if (!document.fullscreenElement && isFractalOpen()) closeFractal();
  });

  // Escape closes whichever of the fractal/visualizer is open. No
  // awareness of any host page's own modal/lightbox state -- a host that
  // wraps this in its own UI (see tuckermills.com's gallery.js) reads
  // isFractalOpen()/isVisualizerOpen() in its OWN keydown listener to
  // decide whether to react to the same press (e.g. suppress its own
  // arrow-key navigation, or defer its own Escape handling to a second
  // press) -- see that listener's own comment for why it runs in the
  // capture phase to observe state before this one can change it.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isFractalOpen()) closeFractal();
    else if (isVisualizerOpen()) closeVisualizer();
  });

  window.FractalizeCore = {
    openFractal,
    closeFractal,
    isFractalOpen,
    openVisualizer,
    closeVisualizer,
    isVisualizerOpen,
    setPhotoCatalog: function (groups) {
      photoCatalog = groups || [];
      // Invalidate rather than immediately rebuild -- both the camera
      // roll and the visualizer's own uploads section are only
      // reachable from inside their respective overlays, and this
      // page's own catalog can only change (uploads added/removed)
      // while both are closed anyway, so the next open already is
      // "immediately" from the visitor's perspective.
      if (cameraRollInvalidate) cameraRollInvalidate();
      if (visualizerUploadsInvalidate) visualizerUploadsInvalidate();
    },
    // Lets a host page build its own "Live audio input" checkbox +
    // device <select> + status text (same four data-hooks the fractal's
    // and visualizer's own panels use -- see wireLiveAudioControls'
    // own comment) and wire it to this same shared microphone stream,
    // wrapped in a [data-live-audio-panel] element so disableLiveAudio
    // knows to keep it in sync with the fractal/visualizer's own
    // copies. fractalize-studio's own page uses this for a setup step
    // before ever opening the fractal/visualizer; tuckermills.com
    // doesn't call it, and nothing here depends on it being called at
    // all.
    wireLiveAudioControls,
    // Reflects the CURRENT shared live-audio state into a panel that's
    // just appeared -- the same sync openFractal/openVisualizer already
    // run on their own panels every time they open (see that function's
    // own comment), exposed so a host page's own panel (wired via
    // wireLiveAudioControls above) can do the same the moment it's
    // shown, e.g. fractalize-studio's "Start" modal: if audio was
    // already granted from this page's other live-audio card, the
    // modal's button should say so immediately, not just after its own
    // checkbox is toggled.
    syncLiveAudioPanel,
    // Opts into the "+" add-photos tile in the fractal's camera-roll
    // grid and the visualizer's own settings panel (see
    // buildAddPhotoTile's own comment) -- fn is called with the
    // FileList a visitor picked there. Call before a visitor can ever
    // open either overlay (both are built lazily on first open, and
    // check this at that point) -- fractalize-studio calls this once at
    // page load, wiring it to the same saveFilesToUploads its own
    // dropzone/add-tile use, so a photo added from inside the fractal/
    // visualizer lands in "Your Uploads" exactly like one added from the
    // page itself. Never called on tuckermills.com, so neither tile
    // renders there.
    setUploadHandler: function (fn) {
      uploadHandler = typeof fn === "function" ? fn : null;
    },
    // Opts out of closeFractal/closeVisualizer's own default of stopping
    // the shared live-audio stream on their way out (see
    // keepLiveAudioOnClose's own comment for why) -- call once, same as
    // setUploadHandler/setPhotoCatalog above; every future close from
    // either overlay checks the flag fresh, not just the one in effect
    // when this was called.
    setKeepLiveAudioOnClose: function (v) {
      keepLiveAudioOnClose = !!v;
    },
  };
})();
