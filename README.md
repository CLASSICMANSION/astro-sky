# Ephemeris — Live Cosmic Dashboard

A real-time sky map that uses your phone's GPS and orientation sensors to
show exactly which stars, planets, the Moon and Sun you're pointing at.

## Run it locally

You need a local web server (browsers block GPS/camera/motion sensors on
plain `file://` pages, but allow them on `localhost`). Pick whichever you
have installed, from this folder:

**Python (usually already installed):**
```
python3 -m http.server 8000
```

**Node:**
```
npx serve -l 8000
```

Then open **`http://localhost:8000`** — on the *same phone* you want to use
(if you're on a laptop, either open it on the laptop's browser and drag to
look around, or find your laptop's LAN IP with `ipconfig`/`ifconfig` and
open `http://<that-ip>:8000` on your phone while it's on the same Wi-Fi;
most phone browsers still treat a local-network address as insecure for
sensors, so testing directly on the phone's own localhost, or over HTTPS,
gives the most reliable results — see the note below).

## Getting sensors working on a phone

- Tap **BEGIN CALIBRATION** — this triggers the motion-sensor and location
  permission prompts. iOS in particular only allows the motion sensor
  prompt to appear in direct response to that tap.
- If your phone doesn't offer GPS/motion at all over `http://`,
  it's a browser security restriction on non-`localhost`, non-`https`
  origins. The cleanest fix is a free HTTPS tunnel while you develop, e.g.
  `npx localtunnel --port 8000` or `ngrok http 8000`, then open the
  `https://` URL it gives you on your phone.
- Every phone compass drifts. If North looks off, point the phone the way
  you know is actually North and tap **⟲ RECENTER** — this recalibrates
  the heading on the spot, exactly like a dedicated star-map app.
- No sensors, or testing on a laptop? Drag anywhere on the screen to look
  around instead.

## What's actually driving it

- `astro.js` — real celestial mechanics: Julian date → Greenwich/Local
  Sidereal Time, low-precision Keplerian orbital elements for the Sun,
  Moon and all seven other planets (Mercury through Neptune), and the
  RA/Dec → Altitude/Azimuth transform for your exact latitude. This is
  the same class of formulas (Paul Schlyter's widely-used low-precision
  elements) used in amateur planetarium tools — accurate to a fraction of
  a degree, which is exactly what a sky map needs. Every named star also
  carries its real distance in light-years; planets and the Moon show
  live-computed distance in AU/km.
- `sky.js` — Three.js scene: ~110 real bright stars (positioned by actual
  RA/Dec, not decoration) against a deep-space gradient backdrop, plus
  procedural filler stars, GPU-shader twinkling, glowing planet sprites,
  a shaded Moon sphere with a real phase computed from the Sun–Moon
  angle, bloom post-processing, and a device-orientation quaternion that
  drives the camera so the view tracks exactly where you point the phone.
- `index.html` — layout, HUD and the cosmic-telemetry visual design.

## Notes on accuracy

Star positions use their real J2000 coordinates. The ~110 named bright
stars are individually catalogued and scientifically positioned; the
denser background starfield (~9,000 points) is procedurally generated but
weighted by real galactic latitude, so the Milky Way band sits exactly
where it actually is in the sky rather than being random noise — all of
it, named and background alike, is recomputed from real RA/Dec every
frame, so it correctly wheels across the sky as the night goes on. Planet
and Moon positions use compact orbital formulas good to about an
arcminute — plenty for a visual sky map, though not observatory-grade.
Constellation lines are simplified line figures, not official IAU
boundaries.

## Rendering quality

The renderer matches your device's native pixel density (up to 3x, i.e.
full "Retina"/high-DPI resolution — most phones render notably sharper
than a laptop here), uses filmic tone mapping for more natural contrast,
runs an SMAA anti-aliasing pass on the final composited image (post-
processing pipelines otherwise re-introduce jagged edges even when the
base renderer is anti-aliased), and adds a subtle motion-trail (afterimage)
pass so sweeping the phone across the sky leaves a brief cinematic blur
rather than a hard, stuttery cut. A soft vignette frames the whole view.

## What's included

- **All 8 planets** (Mercury through Neptune) at their true live position,
  each rendered as an actual lit, textured sphere (procedurally generated
  — banded gas-giant textures for Jupiter/Saturn/Uranus/Neptune, mottled
  rocky textures for Mercury/Venus/Mars) shaded from the Sun's real
  current direction, plus a visible ring on Saturn. Uranus and Neptune
  are far too faint for the naked eye, but their computed position is
  included for completeness — you'd need binoculars or a telescope to
  actually see them.
- **The Moon**, a cratered sphere phase-shaded from the real current
  Sun–Moon angle.
- **The Sun**, rendered with a mottled granulation-like surface texture.
- **112 real named stars** (including the Pleiades cluster), each at its
  true RA/Dec with its real distance in light-years, labeled directly in
  the sky when bright enough to be widely recognized. The brightest three
  (Sirius, Canopus, Rigil Kentaurus) get real diffraction-spike sparkle,
  the way a camera or the eye renders a dazzling point of light. Plus
  ~9,000 procedural background stars density-weighted by actual galactic
  latitude so the Milky Way band — including a soft warm haze layer —
  falls where it really is.
- **Constellation names**, positioned at the true centroid of each
  figure's stars and refreshed live like everything else.
- **An always-on horizontal compass ribbon** at the bottom with a large
  live heading readout (e.g. "240° SW", exactly like a phone's compass
  app), **a toggleable circular compass dial** (COMPASS ON/OFF) that
  rotates as you turn with its own large centered degree readout, live
  dots for the Sun/Moon/planets at their real bearings, and **a vertical
  altitude gauge** on the right edge so it's unambiguous whether you're
  looking up toward the zenith or down toward the ground.
- A ground plane, horizon ring, faint altitude reference circles, and a
  soft atmospheric horizon glow in the 3D view itself, plus N/E/S/W
  letters fixed at their real compass bearings — so "which way am I
  facing, and am I looking up or down" is answered by the view alone.
- Tap the crosshair target or the object list for distance, altitude,
  azimuth, and (for the Moon) illumination percentage.
- A best-effort reverse-geocoded place name under your coordinates
  (purely cosmetic — fails silently if offline).

If the motion-trail blur feels too strong or too subtle on your device,
it's one number: search `AfterimagePass(0.4)` in `sky.js` — higher
(closer to 1) means a longer trail, lower means less.

## Zoom

- **Pinch with two fingers** on the sky to zoom in and out.
- **Scroll wheel** to zoom on a laptop/desktop; **double-click** resets.
- A "⤢ 2.3× · tap to reset" pill appears near the top while zoomed in —
  tap it to ease smoothly back to the normal wide view.
- Zoom eases in and out (a short animated glide, not an instant snap) —
  tune the feel by searching `* 0.18` right after the field-of-view easing
  comment in `sky.js`: a smaller number glides more slowly, a larger one
  snaps faster.

Zoom works by narrowing the camera's field of view — the same principle
as swapping to a telephoto lens. Every star, planet, and the Moon keep
their real computed sky position and their real relative size; zooming
just magnifies the same accurate view, it never swaps in a fake close-up
image, so what you see zoomed in is exactly the real view, just larger.
