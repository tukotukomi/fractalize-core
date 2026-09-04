# Fractalize Core

The shared engine behind [Fractalize Studio](https://fractalize.studio) and
its embedded instance on [tuckermills.com](https://tuckermills.com): a
hand-written WebGL Mandelbrot/Julia-set fractal viewer, a noise-warp
"visualize to music" view, and the live-audio input plumbing they share.
No build step, no dependencies -- two plain files (`fractalize-core.js`,
`fractalize-core.css`) meant to be dropped into a host page.

## Using it in a host page

```html
<link rel="stylesheet" href="fractalize-core.css">
<script src="fractalize-core.js"></script>
```

Load `fractalize-core.js` before any of your own code that calls into it.
Everything is exposed through a single global:

```js
window.FractalizeCore.setPhotoCatalog(groups);
// groups: [{ label, photos: [{ src, thumbSrc }] }]
// Feeds the fractal's camera-roll panel. Call once, whenever your photo
// list is ready (or changes).

window.FractalizeCore.openFractal(srcOrImgEl, opts);
window.FractalizeCore.openVisualizer(srcOrImgEl, opts);
// srcOrImgEl: either an already-loaded <img> element, or a plain src
// string (a freshly created object URL from a file upload, for example) --
// this file loads/decodes it either way, so the caller never has to.
// opts.persistQueue (openFractal only, default true): set to false for a
// session-only source (e.g. an uploaded photo's blob: URL) so it never
// gets written into the persisted camera-roll queue, which would try
// (and fail) to reload a dead blob URL on a future visit.

window.FractalizeCore.closeFractal();
window.FractalizeCore.closeVisualizer();
window.FractalizeCore.isFractalOpen();
window.FractalizeCore.isVisualizerOpen();
```

Nothing else in this file reads any page-global state -- no gallery grid,
no lightbox, no music-player object. It owns its own scroll lock (a
`.fractalize-scroll-lock` class toggled on `<html>`) and its own Escape-key
handling, so it works standalone with no host chrome required. A host page
layering its own modal/lightbox around this (see tuckermills.com's
`gallery.js`) should register its own `keydown` listener in the **capture**
phase if it needs to read `isFractalOpen()`/`isVisualizerOpen()` in
response to the same keypress -- this file's own Escape listener runs in
the bubble phase and will have already acted by the time a bubble-phase
host listener sees the event.

## Consumers

- [tuckermills-portfolio](https://github.com/tukotukomi/tuckermills-portfolio)
  -- embeds this as the "Mandelbrot zoom" / "Visualize to music" buttons on
  photo lightboxes, git submodule at `fractalize-core/`.
- [fractalize-studio](https://github.com/tukotukomi/fractalize-studio) --
  the standalone site at fractalize.studio.

Both include this repo as a git submodule, pinned to a commit and bumped
deliberately when ready to pull in a change -- not a live/CDN dependency.

## Versioning

`FRACTAL_VERSION` (near the top of `fractalize-core.js`) is shown in the
fractal's own settings panel and is updated by hand, to the current HEAD's
short commit hash, as part of any commit that changes this file -- one
commit behind true HEAD is expected, since a commit can't contain its own
hash.
