// Assembles the whole local app (landing + map, app.js, style.css, Leaflet's
// CSS, and the region/landmark data) into one self-contained HTML file
// suitable for publishing as a Claude Artifact:
//   - Leaflet's JS is inlined (not loaded from cdnjs): a report of the map
//     never appearing on mobile - matched exactly what happens if `L` never
//     loads (app.js's very first Leaflet call throws, halting that whole
//     script). Inlining removes that dependency on a third-party script
//     actually reaching this specific device/network. Leaflet's CSS was
//     already inlined the same way, for a different reason (no allowed
//     stylesheet CDN).
//   - The landing "page" and the map "page" become two stacked <div>s in one
//     document, toggled with a fixed-position overlay instead of a second
//     HTML file - the map div is never display:none, so it always has a
//     real size when Leaflet measures it (no hidden-container/zero-size
//     dance needed here).
//   - Stays light-only, same as the local pages: the Artifact host's own
//     shell already declares `color-scheme: light`. app.js's
//     province-line color still reads from a CSS variable rather than a
//     hardcoded literal, just one with a single (light) value.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let css = read("style.css");
css = css.replace(
  "--accent: #2563eb;",
  "--accent: #2563eb;\n  --province-line: #4b5563;"
);
css +=
  "\n" +
  `.landing-overlay:not([hidden]) {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}
`;

let appJs = read("app.js");
appJs = appJs.replace(
  'color: "#4b5563",',
  "color:\n        getComputedStyle(document.documentElement)\n          .getPropertyValue(\"--province-line\")\n          .trim() || \"#4b5563\","
);

const leafletCss = read("vendor/leaflet/leaflet.css");
const leafletJs = read("node_modules/leaflet/dist/leaflet.js");
const regionsData = read("data/regions.data.js");
const landmarksData = read("data/landmarks.js");
const landmarkImagesData = read("data/landmark-images.js");

const html = `<title>여행 지도</title>
<style>
${leafletCss}
${css}
</style>

<header class="topbar">
  <h1>여행 지도</h1>
</header>

<main id="map"></main>

<footer class="toolbar">
  <button class="tool-btn" id="resetBtn" type="button" title="전체 초기화">
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M6 7h12l-1 13.02A2 2 0 0 1 15.01 22H8.99a2 2 0 0 1-1.99-1.98L6 7Zm3-4h6l1 2h4v2H4V5h4l1-2Z"/>
    </svg>
    <span>초기화</span>
  </button>
  <button class="tool-btn" id="homeBtn" type="button" title="메인페이지로">
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M12 3.2 3 10.5v10.3h6v-6.4h6v6.4h6V10.5L12 3.2Z"/>
    </svg>
    <span>메인으로</span>
  </button>
</footer>

<div class="landing-overlay" id="landingOverlay">
  <main class="landing">
    <svg class="landing-icon" viewBox="0 0 24 24" width="48" height="48" aria-hidden="true">
      <path fill="currentColor" d="M12 2C7.86 2 4.5 5.36 4.5 9.5c0 5.5 7.5 12.5 7.5 12.5s7.5-7 7.5-12.5C19.5 5.36 16.14 2 12 2Zm0 10.25a2.75 2.75 0 1 1 0-5.5 2.75 2.75 0 0 1 0 5.5Z"/>
    </svg>
    <h1 class="landing-title">여행 지도</h1>
    <p class="landing-subtitle">지역을 눌러 대표 명소를 만나보세요</p>
    <button class="landing-cta" id="startBtn" type="button">지도 시작하기</button>
  </main>
</div>

<script>
${leafletJs}
</script>
<script>
${regionsData}
</script>
<script>
${landmarksData}
</script>
<script>
${landmarkImagesData}
</script>
<script>
  try {
${appJs}
  } catch (e) {
    console.error("travel-map init failed", e);
    document.getElementById("map").innerHTML =
      '<div style="padding:32px;text-align:center;color:#6b7280;font-size:14px;">지도를 불러오지 못했습니다.<br>페이지를 새로고침해 주세요.</div>';
  }
</script>
<script>
  document.getElementById("startBtn").addEventListener("click", function () {
    document.getElementById("landingOverlay").hidden = true;
  });
  document.getElementById("homeBtn").addEventListener("click", function () {
    document.getElementById("landingOverlay").hidden = false;
  });
</script>
`;

fs.writeFileSync(path.join(root, "dist/travel-map.artifact.html"), html);
console.log(
  "wrote dist/travel-map.artifact.html",
  Math.round(Buffer.byteLength(html) / 1024) + "KB"
);
