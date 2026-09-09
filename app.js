(function () {
  "use strict";

  var UNVISITED_FILL = "#e9edf3";
  var UNVISITED_STROKE = "#c7cfda";
  var ACCENT = "#2563eb";
  // Scoped per user ID (when cloud sync is present) so switching IDs on the
  // same browser doesn't show the previous ID's regions before the cloud
  // fetch resolves, and doesn't bleed one ID's reveals into another's local
  // cache. The Artifact build has no ID concept (window.CloudSync is
  // undefined there), so it keeps the old unscoped key.
  var STORAGE_KEY =
    "travelmap.revealed.v1" + (window.CloudSync ? "." + window.CloudSync.userId : "");

  var data = window.REGIONS_GEOJSON;

  // Which regions are currently peeled open persists across page loads -
  // without this, navigating to the landing page and back (a real page
  // reload on the multi-page GitHub Pages site, unlike the single-file
  // Artifact build where that's just an overlay toggle) reruns this whole
  // script from scratch and any open reveals would silently vanish.
  function loadRevealedIds() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveRevealedIds() {
    var ids = Object.keys(activeReveals);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch (e) {
      /* storage unavailable, ignore */
    }
    if (window.CloudSync) window.CloudSync.saveRevealed(ids);
  }

  function styleFor() {
    return {
      fillColor: UNVISITED_FILL,
      fillOpacity: 1,
      color: UNVISITED_STROKE,
      weight: 1,
      className: "region-shape",
    };
  }

  // ---- map ----
  var map = L.map("map", {
    attributionControl: false,
    zoomControl: true,
    zoomSnap: 0.25,
  });

  var SVG_NS = "http://www.w3.org/2000/svg";
  var XLINK_NS = "http://www.w3.org/1999/xlink";

  // A region "peels" open on click to reveal its landmark photo (or, when
  // no photo was found, a tinted icon) clipped to that region's exact
  // shape - an <image>/<g> clipped with a <clipPath> that copies the
  // clicked path's own `d`, inserted right next to it in the same <svg> so
  // it pans with the map for free (same parent transform as every other
  // path - panning never touches individual paths' `d`, only a shared CSS
  // transform on the whole layer group, so siblings move together with no
  // extra work). Several regions can be open at once. Zooming DOES change
  // projection, so Leaflet rewrites every path's `d` on 'zoomend' - resync
  // each open reveal's clip shape and image/icon position to match rather
  // than clearing them, so they survive a zoom instead of just vanishing.
  var activeReveals = {}; // id -> { el, imageEl, clipShapeEl, layer, plainName }

  // Fast repeated zoom gestures (scroll-wheel flicks, mobile pinch) can make
  // Leaflet/the browser fire a spurious 'click' on the region layer sitting
  // under the pointer as part of that same gesture - indistinguishable from
  // a real click, so it would toggle an open reveal straight back off. A
  // short cooldown spanning the zoom gesture (started on 'zoomstart', reset
  // through the end of 'zoomend') absorbs that without blocking real clicks,
  // which never land this close to a zoom.
  var suppressClickUntil = 0;

  function clearOneReveal(id) {
    var r = activeReveals[id];
    if (!r) return;
    r.el.classList.remove("region-peeling");
    r.el.style.opacity = "";
    r.imageEl.remove();
    r.clipShapeEl.parentNode.remove(); // the <clipPath> wrapping it
    r.layer._labelMarker.setTooltipContent(r.plainName);
    delete activeReveals[id];
    saveRevealedIds();
  }

  function clearAllReveals() {
    Object.keys(activeReveals).forEach(clearOneReveal);
  }

  function positionFallback(g, bbox) {
    var rect = g._rect,
      iconG = g._iconG;
    rect.setAttribute("x", bbox.x);
    rect.setAttribute("y", bbox.y);
    rect.setAttribute("width", bbox.width);
    rect.setAttribute("height", bbox.height);
    var size = Math.min(bbox.width, bbox.height) * 0.55;
    iconG.setAttribute(
      "transform",
      "translate(" +
        (bbox.x + bbox.width / 2 - size / 2) +
        "," +
        (bbox.y + bbox.height / 2 - size / 2) +
        ") scale(" +
        size / 48 +
        ")"
    );
  }

  function buildFallbackContent(bbox, info) {
    var g = document.createElementNS(SVG_NS, "g");
    var rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("fill", ACCENT);
    rect.setAttribute("fill-opacity", "0.12");
    g.appendChild(rect);

    var iconMarkup =
      info && window.LANDMARK_ICONS ? window.LANDMARK_ICONS[info.icon] : null;
    var iconG = document.createElementNS(SVG_NS, "g");
    iconG.setAttribute("fill", "none");
    iconG.setAttribute("stroke", ACCENT);
    iconG.setAttribute("stroke-width", "3");
    iconG.setAttribute("stroke-linecap", "round");
    iconG.setAttribute("stroke-linejoin", "round");
    iconG.innerHTML =
      iconMarkup || '<circle cx="24" cy="24" r="16"/><path d="M17 24h14M24 17v14"/>';
    g.appendChild(iconG);

    g._rect = rect;
    g._iconG = iconG;
    positionFallback(g, bbox);
    return g;
  }

  function resyncOneReveal(id) {
    var r = activeReveals[id];
    if (!r) return;
    var bbox = r.el.getBBox();
    if (!bbox.width || !bbox.height) {
      // A mid-zoom read can race ahead of Leaflet's own path redraw and
      // briefly see a stale/zero-size box - leaving the sticker at its
      // last good position and retrying on the next zoomend is much safer
      // than deleting it outright, since a delete here also erases it from
      // this user's synced cloud record. Previously this called
      // clearOneReveal(id), which is exactly the repeated "reveals vanish
      // while zooming" bug users hit.
      return;
    }
    r.clipShapeEl.setAttribute("d", r.el.getAttribute("d"));
    if (r.imageEl.tagName.toLowerCase() === "image") {
      r.imageEl.setAttribute("x", bbox.x);
      r.imageEl.setAttribute("y", bbox.y);
      r.imageEl.setAttribute("width", bbox.width);
      r.imageEl.setAttribute("height", bbox.height);
    } else {
      positionFallback(r.imageEl, bbox);
    }
  }

  function resyncAllReveals() {
    Object.keys(activeReveals).forEach(resyncOneReveal);
  }

  function revealRegion(feature, layer) {
    var id = feature.properties.id;
    if (activeReveals[id]) {
      clearOneReveal(id); // clicking the open sticker again closes it
      return;
    }

    var el = layer.getElement();
    if (!el || !el.ownerSVGElement) return;
    var svg = el.ownerSVGElement;
    var d = el.getAttribute("d");
    var bbox = el.getBBox();
    if (!bbox.width || !bbox.height) return;

    var info = window.LANDMARKS && window.LANDMARKS[id];
    var photo =
      info && window.LANDMARK_IMAGES ? window.LANDMARK_IMAGES[info.name] : null;

    var defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS(SVG_NS, "defs");
      svg.insertBefore(defs, svg.firstChild);
    }
    var clipId = "region-clip-" + id;
    var clipPath = document.createElementNS(SVG_NS, "clipPath");
    clipPath.setAttribute("id", clipId);
    var clipShape = document.createElementNS(SVG_NS, "path");
    clipShape.setAttribute("d", d);
    clipPath.appendChild(clipShape);
    defs.appendChild(clipPath);

    var imageEl;
    if (photo) {
      imageEl = document.createElementNS(SVG_NS, "image");
      imageEl.setAttributeNS(XLINK_NS, "href", photo.src);
      imageEl.setAttribute("href", photo.src);
      imageEl.setAttribute("x", bbox.x);
      imageEl.setAttribute("y", bbox.y);
      imageEl.setAttribute("width", bbox.width);
      imageEl.setAttribute("height", bbox.height);
      imageEl.setAttribute("preserveAspectRatio", "xMidYMid slice");
    } else {
      imageEl = buildFallbackContent(bbox, info);
    }
    imageEl.setAttribute("clip-path", "url(#" + clipId + ")");
    imageEl.setAttribute("class", "region-reveal");
    imageEl.style.opacity = "0";
    el.parentNode.insertBefore(imageEl, el.nextSibling);

    // "지역(명소이름)" caption takes over the spot the plain region-name
    // tooltip already shows (see the invisible labelMarker in onEachFeature)
    // instead of a separate element, so it inherits that tooltip's
    // positioning/zoom handling for free.
    var plainName = feature.properties.name;
    layer._labelMarker.setTooltipContent(
      plainName + (info ? "(" + info.name + ")" : "")
    );

    el.classList.add("region-peeling");
    requestAnimationFrame(function () {
      imageEl.style.transition = "opacity 260ms ease 100ms";
      imageEl.style.opacity = "1";
    });
    setTimeout(function () {
      el.style.opacity = "0";
    }, 220);

    activeReveals[id] = {
      el: el,
      imageEl: imageEl,
      clipShapeEl: clipShape,
      layer: layer,
      plainName: plainName,
    };
    saveRevealedIds();
  }

  var layersById = {}; // id -> { feature, layer } - for restoring saved reveals

  function revealIds(ids) {
    ids.forEach(function (id) {
      if (activeReveals[id]) return;
      var entry = layersById[id];
      if (entry) revealRegion(entry.feature, entry.layer);
    });
  }

  function restoreReveals() {
    revealIds(loadRevealedIds());
    // Cloud data (another device, or this browser after a cache clear)
    // arrives later than the instant localStorage restore above - merge it
    // in as a union rather than replacing, so nothing already open here
    // gets closed by a slower/stale cloud read.
    if (window.CloudSync) {
      window.CloudSync.loadRevealed().then(function (ids) {
        if (ids) revealIds(ids);
      });
    }
  }

  var geoLayer = L.geoJSON(data, {
    style: styleFor,
    onEachFeature: function (feature, lyr) {
      layersById[feature.properties.id] = { feature: feature, layer: lyr };
      lyr.on("click", function () {
        if (Date.now() < suppressClickUntil) return;
        revealRegion(feature, lyr);
      });
      // Hover highlight is done with the CSS :hover pseudo-class (see
      // style.css) instead of JS mouseover/mouseout + bringToFront(): on an
      // SVG layer, bringToFront() re-inserts the path's DOM node, and doing
      // that while the pointer is over it makes the browser drop the
      // pending mouseout — with 229 small adjacent shapes and fast mouse
      // movement that left stray highlighted borders stuck on screen.
      // Native :hover can't get out of sync like that.
      //
      // The label is bound to an invisible zero-radius marker at a
      // precomputed labelPoint rather than to the polygon itself: Leaflet's
      // own `direction: "center"` for a Path just uses the bounding-box
      // center, which lands outside the shape (or off in the sea toward
      // whatever island is furthest out) for crescent-shaped or scattered
      // multi-island regions. labelPoint (from the build script) is an
      // area-weighted centroid of the largest part, nudged back inside for
      // concave shapes - a marker there positions the tooltip correctly
      // with no extra tracking code, and pans/zooms like any other layer.
      var lp = feature.properties.labelPoint;
      var labelLatLng = lp ? L.latLng(lp[1], lp[0]) : lyr.getBounds().getCenter();
      var labelMarker = L.circleMarker(labelLatLng, {
        radius: 0,
        opacity: 0,
        fillOpacity: 0,
        interactive: false,
      }).addTo(map);
      labelMarker.bindTooltip(feature.properties.name, {
        permanent: true,
        direction: "center",
        className: "region-name",
        interactive: false,
      });
      lyr._labelMarker = labelMarker;
    },
  }).addTo(map);

  // Province / metro-city outlines drawn on top, fill-less and
  // non-interactive so clicks and hover still go to the region underneath.
  L.geoJSON(window.PROVINCES_GEOJSON, {
    interactive: false,
    style: {
      fill: false,
      color: "#4b5563",
      weight: 2,
      opacity: 0.8,
    },
  }).addTo(map);

  var resetBtn = document.getElementById("resetBtn");
  resetBtn.addEventListener("click", function () {
    if (Object.keys(activeReveals).length === 0) return;
    if (!window.confirm("열려있는 명소 이미지를 모두 닫을까요?")) return;
    clearAllReveals();
  });

  var userIdChip = document.getElementById("userIdChip");
  if (userIdChip && window.CloudSync) {
    userIdChip.textContent = window.CloudSync.userId;
    userIdChip.addEventListener("click", function () {
      window.CloudSync.changeUserId();
    });
  }

  // The initial view skips a few far-flung islands (Ulleungdo/Dokdo,
  // Baengnyeongdo) that would otherwise force it to start zoomed way out;
  // window.INITIAL_BOUNDS (from the build script) has that curated extent.
  // They're still part of the data and reachable by panning/zooming out.
  var bounds = window.INITIAL_BOUNDS
    ? L.latLngBounds(window.INITIAL_BOUNDS)
    : geoLayer.getBounds();

  // Region-name labels are only readable once you've zoomed in past the
  // whole-country view (229 of them, 25 packed into tiny Seoul gu, would
  // just be an unreadable smear at the initial zoom). Reveal them a couple
  // of zoom levels past whatever the initial fit turns out to be.
  var labelZoomThreshold = null;
  function updateLabelVisibility() {
    if (labelZoomThreshold === null) return;
    map
      .getContainer()
      .classList.toggle("show-labels", map.getZoom() >= labelZoomThreshold);
  }
  map.on("zoomend", updateLabelVisibility);

  map.on("zoomstart", function () {
    suppressClickUntil = Date.now() + 400;
  });
  map.on("zoomend", function () {
    suppressClickUntil = Date.now() + 400;
  });

  // Zooming makes Leaflet re-project and rewrite every path's `d` (panning
  // doesn't - it's just a shared CSS transform, so open reveals tag along
  // for free). Bring any open reveal's clip shape and image/icon back in
  // line with its region's new `d`/bbox once that settles. A rAF after
  // 'zoomend' avoids a race where this runs before Leaflet has actually
  // finished writing the new `d` attributes for that same event.
  map.on("zoomend", function () {
    requestAnimationFrame(resyncAllReveals);
  });

  function fitToBounds() {
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [12, 12] });
    map.setMinZoom(map.getZoom());
    labelZoomThreshold = map.getZoom() + 2;
    updateLabelVisibility();
    // Same rAF-after-view-change caution as the zoom resync above: give
    // Leaflet a frame to finish writing projected path `d` attributes
    // before revealRegion() reads them via getElement()/getBBox().
    requestAnimationFrame(restoreReveals);
  }

  // #map's height comes from a flex layout; on first paint (or while the
  // tab/pane isn't visible yet) the browser may not have resolved that
  // layout, which would make fitBounds compute against a zero-size
  // container (zoom -> Infinity). Poll until the container has a real
  // size before asking Leaflet to fit to it.
  (function waitForSize(attemptsLeft) {
    var el = map.getContainer();
    if (el.clientWidth > 50 && el.clientHeight > 50) {
      fitToBounds();
    } else if (attemptsLeft > 0) {
      setTimeout(function () {
        waitForSize(attemptsLeft - 1);
      }, 50);
    } else {
      fitToBounds(); // give up waiting, try anyway
    }
  })(100);

  window.addEventListener("resize", function () {
    map.invalidateSize();
  });
})();
