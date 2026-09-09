// Builds data/regions.geo.json:
//   - Seoul (code prefix "11"): kept at gu level (25 features) - the only
//     place gu-level coloring applies.
//   - The other five metropolitan cities (Busan, Daegu, Incheon, Gwangju,
//     Daejeon) and Ulsan: all of their gu/gun merged into one feature each,
//     so they color as a single city like any other si/do-level unit.
//   - Everywhere else: multi-gu cities (Suwon, Cheonan, Jeonju, Pohang,
//     Changwon, Cheongju, Anyang, Ansan, Goyang, Yongin, Seongnam) merged
//     into a single si-level feature; everything else already is a single
//     si/gun feature.
const fs = require("fs");
const path = require("path");
const topojson = require("topojson-client");
const turf = require("@turf/turf");

const src = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../data/municipalities.json"), "utf8")
);
const objectKey = Object.keys(src.objects)[0];
const fc = topojson.feature(src, src.objects[objectKey]);

const PROVINCE_BY_PREFIX = {
  11: "서울특별시",
  21: "부산광역시",
  22: "대구광역시",
  23: "인천광역시",
  24: "광주광역시",
  25: "대전광역시",
  26: "울산광역시",
  29: "세종특별자치시",
  31: "경기도",
  32: "강원특별자치도",
  33: "충청북도",
  34: "충청남도",
  35: "전북특별자치도",
  36: "전라남도",
  37: "경상북도",
  38: "경상남도",
  39: "제주특별자치도",
};

// Metro cities other than Seoul dissolve entirely into one feature, so they
// share the whole city's 2-digit province prefix as their group key.
// Everything else (Seoul's gu, and ordinary si/gun) groups by the 4-digit
// city code, which only merges multi-gu ordinary cities (5th digit is the
// gu) and otherwise leaves each si/gun as its own group of one.
var METRO_PREFIXES_TO_MERGE = ["21", "22", "23", "24", "25", "26"];
function groupKey(code) {
  var prefix2 = code.slice(0, 2);
  if (METRO_PREFIXES_TO_MERGE.includes(prefix2)) return prefix2;
  return code.slice(0, 4);
}

const groups = new Map();
for (const f of fc.features) {
  const key = groupKey(f.properties.code);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(f);
}

function commonCityName(names) {
  // "수원시장안구" vs "수원시권선구" -> "수원시"
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.endsWith("시") ? prefix : prefix;
}

const outFeatures = [];
for (const [key, feats] of groups) {
  if (feats.length === 1) {
    outFeatures.push(feats[0]);
    continue;
  }
  // merge multiple gu/gun into one polygon
  let merged = feats[0];
  for (const f of feats.slice(1)) {
    merged = turf.union(turf.featureCollection([merged, f]));
  }
  var isMetroMerge = METRO_PREFIXES_TO_MERGE.includes(key);
  var name = isMetroMerge
    ? PROVINCE_BY_PREFIX[key]
    : commonCityName(feats.map((f) => f.properties.name));
  merged.properties = {
    name: name,
    code: key + "0",
    name_eng: feats[0].properties.name_eng.split(/(?=[A-Z])/)[0], // best effort
  };
  outFeatures.push(merged);
}

// A visually-centered spot for the name label: the bounding-box center
// Leaflet's tooltip `direction: "center"` uses by default lands outside
// the landmass for crescent/L-shaped counties and drifts toward whichever
// island is furthest out for multi-part coastal ones. Take the largest
// part (ignore tiny outlying islands pulling it off-center), then its
// area-weighted centroid - falling back to a guaranteed-interior point
// for concave shapes where that centroid itself lands outside the shape.
function computeLabelPoint(geometry) {
  const parts = turf.flatten(geometry).features;
  let largest = parts[0];
  let largestArea = turf.area(largest);
  for (const p of parts.slice(1)) {
    const a = turf.area(p);
    if (a > largestArea) {
      largest = p;
      largestArea = a;
    }
  }
  let pt = turf.centerOfMass(largest);
  if (!turf.booleanPointInPolygon(pt, largest)) {
    pt = turf.pointOnFeature(largest);
  }
  return pt.geometry.coordinates;
}

const out = {
  type: "FeatureCollection",
  features: outFeatures.map((f) => {
    let simplified;
    try {
      simplified = turf.simplify(f, { tolerance: 0.001, highQuality: false });
    } catch (e) {
      simplified = f; // tiny islands etc. that don't survive simplification
    }
    const truncated = turf.truncate(simplified, {
      precision: 5,
      coordinates: 2,
    });
    return {
      type: "Feature",
      properties: {
        id: f.properties.code,
        name: f.properties.name,
        province: PROVINCE_BY_PREFIX[f.properties.code.slice(0, 2)],
        isSeoulGu: f.properties.code.startsWith("11"),
        labelPoint: computeLabelPoint(truncated.geometry),
      },
      geometry: truncated.geometry,
    };
  }),
};

// Dissolve into one outline per 시/도 (province / metropolitan city) so the
// map can show those larger boundaries too. Union the RAW (pre-simplify)
// geometries, not the already-simplified `out.features` ones: neighboring
// si/gun/gu were each simplified independently above, which can nudge
// their shared border apart by a coordinate or two, and turf.union() of
// two polygons whose "shared" edge no longer quite lines up leaves sliver
// triangles behind. Unioning first (while borders are still exact, shared
// topojson arcs) and simplifying once after avoids that entirely.
const byProvince = new Map();
for (const f of outFeatures) {
  const key = PROVINCE_BY_PREFIX[f.properties.code.slice(0, 2)];
  if (!byProvince.has(key)) byProvince.set(key, []);
  byProvince.get(key).push({ type: "Feature", properties: {}, geometry: f.geometry });
}

// Even unioning raw shared-arc geometry isn't perfectly clean: complex
// multi-polygon boolean ops occasionally leave a handful of degenerate
// sliver polygons at the seams (near-zero area, wildly disproportionate
// perimeter - a real island that small is still roughly round, not a
// needle). Drop any piece whose shape is both tiny and that thin.
function isSliver(ring) {
  var area = Math.abs(turf.area(turf.polygon([ring])));
  var perim = 0;
  for (var i = 0; i < ring.length - 1; i++) {
    perim += turf.distance(turf.point(ring[i]), turf.point(ring[i + 1]), {
      units: "meters",
    });
  }
  var compactness = perim > 0 ? (4 * Math.PI * area) / (perim * perim) : 0;
  return area < 500000 && compactness < 0.15;
}

function dropSlivers(geometry) {
  var polygons = turf.flatten(geometry).features.filter(function (poly) {
    return !isSliver(poly.geometry.coordinates[0]);
  });
  if (polygons.length === 0) return geometry; // don't discard everything
  if (polygons.length === 1) return polygons[0].geometry;
  return {
    type: "MultiPolygon",
    coordinates: polygons.map(function (p) {
      return p.geometry.coordinates;
    }),
  };
}

const provinceFeatures = [];
for (const [name, feats] of byProvince) {
  let merged =
    feats.length === 1
      ? feats[0]
      : turf.union(turf.featureCollection(feats));
  let simplified;
  try {
    simplified = turf.simplify(merged, { tolerance: 0.001, highQuality: false });
  } catch (e) {
    simplified = merged;
  }
  const truncated = turf.truncate(simplified, { precision: 5, coordinates: 2 });
  provinceFeatures.push({
    type: "Feature",
    properties: { name },
    geometry: dropSlivers(truncated.geometry),
  });
}

const provincesOut = { type: "FeatureCollection", features: provinceFeatures };

// The initial map view fits every feature's full extent by default, but a
// handful of far-flung islands (Ulleungdo/Dokdo off the east coast,
// Baengnyeongdo off the west coast) sit so far from the rest of the country
// that including them forces the whole map to start zoomed much further out
// than the mainland alone needs. Compute a separate "initial view" bbox
// that leaves those out - the regions/features themselves are unchanged
// (still there, still colorable, still reachable by panning), only the
// default starting view excludes them.
const BAENGNYEONG_LON_CUTOFF = 125.0; // everything further west is that cluster
let initialBbox = null;
function extendBbox(bbox) {
  if (!initialBbox) {
    initialBbox = bbox.slice();
    return;
  }
  initialBbox[0] = Math.min(initialBbox[0], bbox[0]);
  initialBbox[1] = Math.min(initialBbox[1], bbox[1]);
  initialBbox[2] = Math.max(initialBbox[2], bbox[2]);
  initialBbox[3] = Math.max(initialBbox[3], bbox[3]);
}

for (const f of out.features) {
  if (f.properties.name === "울릉군") continue; // Ulleungdo + Dokdo

  if (f.properties.name === "인천광역시") {
    // Keep Ganghwado, the mainland coast, and the nearer islands; drop just
    // the Baengnyeongdo/Daecheongdo/Socheongdo cluster far to the west.
    for (const part of turf.flatten(f.geometry).features) {
      const bbox = turf.bbox(part);
      if (bbox[0] < BAENGNYEONG_LON_CUTOFF) continue;
      extendBbox(bbox);
    }
    continue;
  }

  extendBbox(turf.bbox(f.geometry));
}

const initialBounds = [
  [initialBbox[1], initialBbox[0]],
  [initialBbox[3], initialBbox[2]],
];

fs.writeFileSync(
  path.join(__dirname, "../data/regions.geo.json"),
  JSON.stringify(out)
);
fs.writeFileSync(
  path.join(__dirname, "../data/provinces.geo.json"),
  JSON.stringify(provincesOut)
);
// also emit as plain <script> globals so index.html works over file:// too
// (fetch() of local JSON is blocked by CORS in most browsers when opened
// directly from disk, without needing a dev server)
fs.writeFileSync(
  path.join(__dirname, "../data/regions.data.js"),
  "window.REGIONS_GEOJSON = " +
    JSON.stringify(out) +
    ";\nwindow.PROVINCES_GEOJSON = " +
    JSON.stringify(provincesOut) +
    ";\nwindow.INITIAL_BOUNDS = " +
    JSON.stringify(initialBounds) +
    ";"
);
console.log("wrote", out.features.length, "region features,", provinceFeatures.length, "province outlines");
