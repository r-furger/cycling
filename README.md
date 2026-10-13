# VeloCH – personal Swiss cycling navigator

A komoot-style web app for cycling in Switzerland, built as a static, installable
progressive web app (PWA). No backend, no accounts, no paid APIs — everything runs in
your browser and talks only to free public services.

## Features

- **Maps** – swisstopo national map, grey map and aerial imagery (official open data,
  all of Switzerland), plus CyclOSM, OpenStreetMap and OpenTopoMap. Overlays for the
  SchweizMobil cycling routes (Veloland), mountain-bike routes and public transport stops.
- **Offline maps** – swisstopo tiles you look at are cached automatically; "Offline maps"
  on a route pre-downloads the whole corridor (zoom 9–16) for riding without reception.
- **GPX import / export** – drag a GPX file onto the page or use *Import GPX*. Routes are
  stored on the device (IndexedDB). Export or share as GPX.
- **Elevation profiles** – from the swisstopo terrain model (accurate, consistent) with
  gradient colouring, hover to see the point on the map, live progress while navigating.
- **Route planning** – tap waypoints on the map; routing by the public BRouter server with
  bike profiles (touring, road, gravel, MTB, safest, shortest). Turn hints are kept.
- **GPS navigation** – follow-the-track for imported GPX, turn-by-turn for planned routes,
  voice instructions, off-route warning, remaining distance / climb / ETA, screen stays on,
  recorded track that can be saved as a route.
- **Rides are saved automatically** – every navigation or free ride is written to the
  device every few seconds. If the page reloads or the OS kills the app, reopen it and tap
  *Resume* to continue the same ride (or *Finish* to save it as it is).
- **Stats dashboard** – weekly goal with progress, totals for week / month / year / all
  time, a 12-week chart (distance, calories, moving time, climbing), personal bests and
  the ride list. Calories come from a physics model (rolling resistance, air drag,
  climbing from the swisstopo terrain model) using your weight and bike weight.
- **Ride photos** – tap the camera in the ride display to take a photo; it is pinned on
  the map at your GPS position and attached to the ride. Photos can also be added to a
  ride later from the gallery: they are placed by their EXIF location, or by matching the
  photo time to your track. Tap a pin for the full-screen viewer (share, delete), and the
  ride's GPX export carries the photos as waypoints. Photos are stored on the device
  (downscaled to 1600 px) and never uploaded anywhere.
- **Export** – rides as JSON or CSV, plus a copyable summary.
- **Nearby** – train stations, bus/Postauto stops, cable cars / gondolas / chairlifts /
  funiculars, boat piers, bike shops and drinking water from OpenStreetMap, with opening
  hours (evaluated for "open now / closes at"), operator, website, bike transport info,
  and live departures from the Swiss public transport timetable.

## Background GPS – the honest limitation

Web apps cannot receive location updates while they are closed or while the phone is
locked; iOS and Android suspend them. VeloCH keeps the screen awake while a ride is
running, so mount the phone and leave the app on screen. If the app is still interrupted,
nothing is lost: the ride resumes on reopening. True background tracking would need a
native wrapper (for example Capacitor with a background-geolocation plugin) around this
same code.

## Run it locally

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Open <http://localhost:8765>. GPS and installation only work on `localhost` or over HTTPS.

## Put it online (free) so you can use it on your phone

The app is plain static files, so any static host works. GitHub Pages is the simplest:

1. Create a repository on GitHub (public or private), e.g. `cycling`.
2. In this folder:
   ```bash
   git init && git add . && git commit -m "VeloCH"
   git branch -M main
   git remote add origin https://github.com/<you>/cycling.git
   git push -u origin main
   ```
3. On GitHub: *Settings → Pages → Source: Deploy from a branch → main / (root)*.
4. After a minute the app is live at `https://<you>.github.io/cycling/` over HTTPS.
5. On your phone open that URL, then *Add to Home Screen* (iOS Safari: Share → Add to
   Home Screen; Android Chrome: menu → Install app). It then runs full-screen like a
   native app and keeps working offline for saved routes and cached maps.

Netlify Drop, Cloudflare Pages or Vercel work the same way (drag the folder in).

## Data sources and limits

| Service | Used for | Notes |
|---|---|---|
| wmts.geo.admin.ch | swisstopo map tiles | Free open government data |
| api3.geo.admin.ch | elevation profiles, place search | Free, no key |
| brouter.de | bike routing | Free community server, be considerate |
| overpass.osm.ch / overpass-api.de | nearby POIs, opening hours | OpenStreetMap data (ODbL) |
| transport.opendata.ch | live departures | Free, ~1000 requests/day per IP |
| tile.openstreetmap.org, CyclOSM, OpenTopoMap | alternative base maps | Not bulk-downloaded (tile usage policies) |

Opening hours of cable cars depend on what OpenStreetMap mappers entered; many Swiss
lifts only have seasonal information, so the popup also offers the operator website and a
"Find hours" search.

## Files

- `index.html`, `css/style.css` – layout (bottom sheet on phones, side panel on desktop)
- `js/main.js` – app glue; `js/map.js` – layers; `js/gpx.js`, `js/elevation.js`,
  `js/profile.js`, `js/router.js`, `js/nav.js`, `js/nearby.js`, `js/storage.js`,
  `js/offline.js`, `js/geo.js`, `js/fitness.js` (stats & calories), `js/dashboard.js`, `js/photos.js`
- `sw.js` – service worker (offline app shell + tile cache), `manifest.webmanifest`, `icons/`
