// Procedural material swatches. Every finish in the catalog draws its own sample card from a
// small spec (base colour, pattern, variant), seeded so the same finish always looks the same.
//
// swatchMarkup(spec, seed, place) returns SVG markup as a string. "place" names where the
// swatch sits (a tile, the product card...) so filter and gradient ids stay unique on the page.
//
// The drawing functions below call svg(tag, attributes, ...children), which writes markup the
// way a recipe card lists ingredients: tag name first, then its settings, then what goes inside.

// SVG attribute names written in camelCase; every other camelCase name becomes kebab-case
// (strokeWidth -> stroke-width).
const SVG_CAMEL = {
  viewBox: true,
  preserveAspectRatio: true,
  baseFrequency: true,
  numOctaves: true,
  stitchTiles: true,
  stdDeviation: true,
  spreadMethod: true,
  gradientUnits: true,
  gradientTransform: true,
  patternUnits: true,
  patternTransform: true,
};

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function attributeName(name) {
  if (name === "className") {
    return "class";
  }
  if (SVG_CAMEL[name]) {
    return name;
  }
  return name.replace(/[A-Z]/g, function (letter) {
    return "-" + letter.toLowerCase();
  });
}

function styleText(style) {
  return Object.keys(style)
    .map(function (name) {
      return attributeName(name) + ": " + style[name];
    })
    .join("; ");
}

function flatten(children, out) {
  children.forEach(function (child) {
    if (
      child === null ||
      child === undefined ||
      child === false ||
      child === true
    ) {
      return;
    }
    if (Array.isArray(child)) {
      flatten(child, out);
    } else {
      out.push(String(child));
    }
  });
  return out;
}

const Fragment = "fragment";

function svg(tag, attributes) {
  const children = Array.prototype.slice.call(arguments, 2);
  if (typeof tag === "function") {
    const props = Object.assign({}, attributes || {});
    props.children = children;
    return tag(props);
  }
  const inner = flatten(children, []).join("");
  if (tag === Fragment) {
    return inner;
  }
  let open = "<" + tag;
  if (attributes) {
    Object.keys(attributes).forEach(function (name) {
      const value = attributes[name];
      if (
        name === "key" ||
        value === null ||
        value === undefined ||
        value === false
      ) {
        return;
      }
      if (name === "style" && typeof value === "object") {
        open += ' style="' + escapeAttribute(styleText(value)) + '"';
        return;
      }
      open += " " + attributeName(name) + '="' + escapeAttribute(value) + '"';
    });
  }
  return inner ? open + ">" + inner + "</" + tag + ">" : open + "/>";
}

const W = 160;
const H = 112;
function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function makeRandom(seedText) {
  let state = hashString(seedText) || 1;
  return function () {
    state = (state + 1831565813) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}
function rgbToHex(rgb) {
  return (
    "#" +
    rgb
      .map(function (channel) {
        return Math.max(0, Math.min(255, Math.round(channel)))
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}
function mixHex(fromHex, toHex, amount) {
  const from = hexToRgb(fromHex);
  const to = hexToRgb(toHex);
  return rgbToHex([
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ]);
}
function shade(hex, amount) {
  if (amount < 0) {
    return mixHex(hex, "#000000", -amount);
  }
  return mixHex(hex, "#ffffff", amount);
}
function Grain(props) {
  return svg(
    "g",
    null,
    svg(
      "filter",
      { id: props.id, x: `0`, y: `0`, width: `100%`, height: `100%` },
      svg("feTurbulence", {
        type: `fractalNoise`,
        baseFrequency: props.frequency || 0.85,
        numOctaves: props.octaves || 2,
        seed: props.seed || 3,
        stitchTiles: `stitch`,
      }),
      svg("feColorMatrix", { type: `saturate`, values: `0` }),
    ),
    svg("rect", {
      width: W,
      height: H,
      filter: `url(#` + props.id + `)`,
      opacity: props.opacity || 0.08,
      style: {
        mixBlendMode: `multiply`,
      },
    }),
  );
}
function Cloud(props) {
  let t = props.id + `l`;
  let n = props.id + `d`;
  // "stitch" asks the turbulence function itself for noise that is mathematically periodic
  // over the filter region, so it tiles with no seam - but it also shifts the noise's exact
  // appearance very slightly (the effective frequency gets nudged so an integer number of
  // periods fit), so it stays off for the small on-screen cards (forTiling not set) and only
  // turns on for physically-tiled catalogue textures.
  let stitch = props.forTiling ? `stitch` : void 0;
  return svg(
    "g",
    null,
    svg(
      "filter",
      { id: t, x: `0`, y: `0`, width: `100%`, height: `100%` },
      svg("feTurbulence", {
        type: `fractalNoise`,
        baseFrequency: props.frequency || 0.014,
        numOctaves: `3`,
        seed: props.seed || 7,
        stitchTiles: stitch,
      }),
      svg("feColorMatrix", {
        type: `matrix`,
        values: `0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.6 0 0 0 -0.75`,
      }),
    ),
    svg(
      "filter",
      { id: n, x: `0`, y: `0`, width: `100%`, height: `100%` },
      svg("feTurbulence", {
        type: `fractalNoise`,
        baseFrequency: (props.frequency || 0.014) * 1.3,
        numOctaves: `3`,
        seed: (props.seed || 7) + 11,
        stitchTiles: stitch,
      }),
      svg("feColorMatrix", {
        type: `matrix`,
        values: `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.6 0 0 0 0.85`,
      }),
    ),
    svg("rect", {
      width: W,
      height: H,
      filter: `url(#` + t + `)`,
      opacity: props.light === void 0 ? 0.55 : props.light,
    }),
    svg("rect", {
      width: W,
      height: H,
      filter: `url(#` + n + `)`,
      opacity: props.dark === void 0 ? 0.22 : props.dark,
    }),
  );
}
// Carries the pattern's own forTiling flag down into Cloud, whose call sites each pass a
// different, unrelated set of props (light/dark/frequency/seed) that don't otherwise include it.
function CloudTiled(outerProps, cloudProps) {
  return svg(Cloud, Object.assign({}, cloudProps, { forTiling: outerProps.forTiling }));
}
function Sheen(props) {
  let t = props.id;
  return svg(
    "g",
    null,
    svg(
      "linearGradient",
      { id: t, x1: `0`, y1: `0`, x2: `1`, y2: `1` },
      svg("stop", {
        offset: `0`,
        stopColor: `#fff`,
        stopOpacity: props.strength || 0.18,
      }),
      svg("stop", { offset: `0.45`, stopColor: `#fff`, stopOpacity: `0` }),
      svg("stop", {
        offset: `1`,
        stopColor: `#000`,
        stopOpacity: (props.strength || 0.18) * 0.6,
      }),
    ),
    svg("rect", { width: W, height: H, fill: `url(#` + t + `)` }),
  );
}
// Sheen is a corner-to-corner vignette: a one-off highlight tuned for a single small sample
// card, not something a repeating tile should carry. Baked into a large texture, it would read
// as a fake directional light that fights the room's own real lighting once the renderer
// multiplies this texture by Marigold-IID's actual per-pixel shading - so every physically
// tiled texture skips it, while the on-screen catalogue cards (forTiling not set) keep it.
function SheenMaybe(outerProps, sheenProps) {
  return outerProps.forTiling ? null : svg(Sheen, sheenProps);
}
function PaintSwatch(props) {
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: props.spec.hex }),
    svg(Grain, { id: props.uid + `n`, opacity: 0.05 }),
    SheenMaybe(props, { id: props.uid + `s`, strength: 0.12 }),
  );
}
function PlasterSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let t_base = spec.base;
  let i = [];
  if (spec.variant === `venetian` || spec.variant === `microcement`) {
    for (let e = 0; e < 9; e += 1) {
      let a2 = random() * W;
      let o = random() * H;
      let s = 30 + random() * 50;
      i.push(
        svg("path", {
          key: `arc` + e,
          d:
            `M` +
            (a2 - s) +
            ` ` +
            o +
            ` Q ` +
            a2 +
            ` ` +
            (o - s * 0.5) +
            ` ` +
            (a2 + s) +
            ` ` +
            o,
          stroke:
            spec.variant === `venetian` ? `#ffffff` : shade(t_base, -0.25),
          strokeWidth:
            spec.variant === `venetian` ? 5 + random() * 6 : 2 + random() * 3,
          strokeOpacity: spec.variant === `venetian` ? 0.18 : 0.14,
          fill: `none`,
          strokeLinecap: `round`,
        }),
      );
    }
  }
  if (spec.variant === `concrete`) {
    for (let e = 1; e < 6; e += 1) {
      i.push(
        svg("line", {
          key: `b` + e,
          x1: `0`,
          x2: W,
          y1: e * 20,
          y2: e * 20 + (random() - 0.5) * 2,
          stroke: shade(t_base, -0.28),
          strokeOpacity: `0.35`,
          strokeWidth: `0.8`,
        }),
      );
    }
    for (let e = 0; e < 26; e += 1) {
      i.push(
        svg("circle", {
          key: `p` + e,
          cx: random() * W,
          cy: random() * H,
          r: 0.4 + random() * 1.1,
          fill: shade(t_base, -0.45),
          opacity: `0.5`,
        }),
      );
    }
  }
  if (spec.variant === `polished`) {
    for (let e = 0; e < 160; e += 1) {
      i.push(
        svg("circle", {
          key: `a` + e,
          cx: random() * W,
          cy: random() * H,
          r: 0.3 + random() * 1.4,
          fill: random() > 0.5 ? shade(t_base, -0.4) : shade(t_base, 0.35),
          opacity: `0.55`,
        }),
      );
    }
    i.push(
      svg("line", {
        key: `joint`,
        x1: `0`,
        x2: W,
        y1: H * 0.62,
        y2: H * 0.62,
        stroke: shade(t_base, -0.35),
        strokeWidth: `0.8`,
      }),
    );
  }
  if (spec.variant === `epoxy`) {
    i.push(
      svg("rect", {
        key: `r1`,
        x: `34`,
        y: `6`,
        width: `22`,
        height: `60`,
        fill: `#fff`,
        opacity: `0.32`,
        transform: `skewX(-12)`,
      }),
    );
    i.push(
      svg("rect", {
        key: `r2`,
        x: `64`,
        y: `6`,
        width: `22`,
        height: `60`,
        fill: `#fff`,
        opacity: `0.32`,
        transform: `skewX(-12)`,
      }),
    );
  }
  let a =
    spec.variant === `limewash`
      ? {
          light: 0.75,
          dark: 0.32,
          frequency: 0.012,
        }
      : spec.variant === `araish`
        ? {
            light: 0.35,
            dark: 0.08,
            frequency: 0.01,
          }
        : spec.variant === `venetian`
          ? {
              light: 0.5,
              dark: 0.22,
              frequency: 0.018,
            }
          : spec.variant === `concrete`
            ? {
                light: 0.3,
                dark: 0.3,
                frequency: 0.03,
              }
            : {
                light: 0.4,
                dark: 0.2,
                frequency: 0.016,
              };
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: t_base }),
    CloudTiled(props, {
      id: props.uid + `c`,
      seed: props.seedNumber,
      light: a.light,
      dark: a.dark,
      frequency: a.frequency,
    }),
    i,
    svg(Grain, {
      id: props.uid + `n`,
      opacity: spec.variant === `concrete` ? 0.16 : 0.06,
      frequency: 0.9,
    }),
    (spec.variant === `araish` ||
      spec.variant === `venetian` ||
      spec.variant === `epoxy`) &&
      SheenMaybe(props, { id: props.uid + `s`, strength: 0.3 }),
  );
}
function woodTone(e, base, dark) {
  return mixHex(base, dark, e() * 0.75);
}
function WoodSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let r = [];
  if (spec.pattern === `herringbone` || spec.pattern === `chevron`) {
    for (let e = -1; e < 4.636363636363637; e += 1) {
      let i = e * 22 * 2;
      for (let a = -3; a < 12.615384615384615; a += 1) {
        let o = a * 13;
        let s = spec.pattern === `herringbone` ? 13 / 2 : 0;
        let c = [i, o, i + 22, o - 22, i + 22, o - 22 + 13, i, o + 13];
        let l = [
          i + 22,
          o - 22 + s,
          i + 44,
          o + s,
          i + 44,
          o + 13 + s,
          i + 22,
          o - 22 + 13 + s,
        ];
        r.push(
          svg("polygon", {
            key: `l` + e + `-` + a,
            points: c.join(` `),
            fill: woodTone(random, spec.base, spec.dark),
            stroke: shade(spec.dark, -0.35),
            strokeOpacity: `0.5`,
            strokeWidth: `0.6`,
          }),
        );
        r.push(
          svg("polygon", {
            key: `r` + e + `-` + a,
            points: l.join(` `),
            fill: woodTone(random, spec.base, spec.dark),
            stroke: shade(spec.dark, -0.35),
            strokeOpacity: `0.5`,
            strokeWidth: `0.6`,
          }),
        );
      }
    }
  } else {
    let e =
      spec.pattern === `wideplank` ? 24 : spec.pattern === `tongue` ? 11 : 17;
    for (let i = 0; i * e < H; i += 1) {
      let a = spec.pattern === `tongue` ? 0 : -random() * 60;
      while (a < W) {
        let o = spec.pattern === `tongue` ? W : 55 + random() * 70;
        let s = i * e;
        let c = woodTone(random, spec.base, spec.dark);
        r.push(
          svg("rect", {
            key: `p` + i + `-` + a.toFixed(1),
            x: a,
            y: s,
            width: o,
            height: e,
            fill: c,
          }),
        );
        for (let c2 = 0; c2 < 3; c2 += 1) {
          let l = s + 3 + random() * (e - 6);
          r.push(
            svg("path", {
              key: `g` + i + `-` + a.toFixed(1) + `-` + c2,
              d:
                `M` +
                a +
                ` ` +
                l +
                ` C ` +
                (a + o * 0.3) +
                ` ` +
                (l + (random() - 0.5) * 4) +
                `, ` +
                (a + o * 0.6) +
                ` ` +
                (l + (random() - 0.5) * 4) +
                `, ` +
                (a + o) +
                ` ` +
                l,
              stroke: shade(spec.dark, -0.3),
              strokeOpacity: 0.18 + random() * 0.15,
              strokeWidth: `0.6`,
              fill: `none`,
            }),
          );
        }
        r.push(
          svg("line", {
            key: `j` + i + `-` + a.toFixed(1),
            x1: a,
            x2: a,
            y1: s,
            y2: s + e,
            stroke: shade(spec.dark, -0.45),
            strokeOpacity: `0.55`,
            strokeWidth: `0.8`,
          }),
        );
        a += o;
      }
      r.push(
        svg("line", {
          key: `row` + i,
          x1: `0`,
          x2: W,
          y1: i * e,
          y2: i * e,
          stroke: shade(spec.dark, -0.45),
          strokeOpacity: `0.6`,
          strokeWidth: `0.8`,
        }),
      );
    }
  }
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: spec.base }),
    r,
    svg(Grain, { id: props.uid + `n`, opacity: 0.07 }),
    SheenMaybe(props, { id: props.uid + `s`, strength: 0.1 }),
  );
}
function SlatSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let r = props.uid + `f`;
  let i = [];
  let a = spec.fluted ? 10 : 9;
  let o = spec.fluted ? 0.8 : 4;
  for (let e = 0; e < W; e += a + o) {
    i.push(
      svg("rect", {
        key: `s` + e,
        x: e,
        y: `0`,
        width: a,
        height: H,
        fill: mixHex(spec.base, spec.gap, random() * 0.25),
      }),
    );
    i.push(
      svg("rect", {
        key: `h` + e,
        x: e,
        y: `0`,
        width: a,
        height: H,
        fill: `url(#` + r + `)`,
      }),
    );
  }
  return svg(
    "g",
    null,
    svg(
      "linearGradient",
      { id: r, x1: `0`, y1: `0`, x2: `1`, y2: `0` },
      svg("stop", {
        offset: `0`,
        stopColor: `#000`,
        stopOpacity: spec.fluted ? 0.35 : 0.18,
      }),
      svg("stop", {
        offset: `0.45`,
        stopColor: `#fff`,
        stopOpacity: spec.fluted ? 0.22 : 0.08,
      }),
      svg("stop", {
        offset: `1`,
        stopColor: `#000`,
        stopOpacity: spec.fluted ? 0.4 : 0.22,
      }),
    ),
    svg("rect", { width: W, height: H, fill: spec.gap }),
    i,
    svg(Grain, { id: props.uid + `n`, opacity: 0.06 }),
  );
}
function PanelSwatch(props) {
  let spec = props.spec;
  let n = [];
  for (let e = 0; e < 3; e += 1) {
    let r = 10 + e * 48;
    n.push(
      svg("rect", {
        key: `o` + e,
        x: r,
        y: `64`,
        width: `42`,
        height: `40`,
        fill: `none`,
        stroke: shade(spec.trim, -0.12),
        strokeWidth: `2.4`,
      }),
    );
    n.push(
      svg("rect", {
        key: `i` + e,
        x: r + 1.5,
        y: `65.5`,
        width: `39`,
        height: `37`,
        fill: `none`,
        stroke: `#fff`,
        strokeOpacity: `0.7`,
        strokeWidth: `0.8`,
      }),
    );
  }
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: spec.base }),
    svg("rect", { x: `0`, y: `54`, width: W, height: `4`, fill: spec.trim }),
    svg("rect", {
      x: `0`,
      y: `58`,
      width: W,
      height: `1`,
      fill: shade(spec.trim, -0.2),
    }),
    n,
    SheenMaybe(props, { id: props.uid + `s`, strength: 0.12 }),
  );
}
function StoneSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let r = props.uid + `b`;
  let i = [];
  function vein(e, i2, a, o, s, strokeWidth, strokeOpacity) {
    let u = i2;
    let d = a;
    let f = `M` + u.toFixed(1) + ` ` + d.toFixed(1);
    for (let e2 = 0; e2 < 6; e2 += 1) {
      let e3 = s + (random() - 0.5) * 0.9;
      let t = o / 6;
      let r2 = u + Math.cos(e3) * t * 0.5 + (random() - 0.5) * 8;
      let i3 = d + Math.sin(e3) * t * 0.5 + (random() - 0.5) * 8;
      u += Math.cos(e3) * t;
      d += Math.sin(e3) * t;
      f +=
        ` Q ` +
        r2.toFixed(1) +
        ` ` +
        i3.toFixed(1) +
        ` ` +
        u.toFixed(1) +
        ` ` +
        d.toFixed(1);
    }
    return svg("path", {
      key: e,
      d: f,
      stroke: spec.vein,
      strokeWidth,
      strokeOpacity,
      fill: `none`,
      filter: `url(#` + r + `)`,
    });
  }
  if (spec.variant === `marble` || spec.variant === `bookmatch`) {
    let e = [];
    for (let t = 0; t < 4; t += 1) {
      e.push(
        vein(
          `v` + t,
          -10 + random() * 40,
          random() * H,
          200,
          -0.5 + random() * 0.6,
          0.8 + random() * 1.8,
          0.45 + random() * 0.3,
        ),
      );
    }
    for (let t = 0; t < 7; t += 1) {
      e.push(
        vein(
          `t` + t,
          random() * W,
          random() * H,
          60 + random() * 60,
          random() * Math.PI * 2,
          0.4,
          0.35,
        ),
      );
    }
    if (spec.variant === `bookmatch`) {
      i.push(svg("g", { key: `left` }, e));
      i.push(
        svg(
          "g",
          { key: `right`, transform: `translate(160 0) scale(-1 1)` },
          e,
        ),
      );
      i.push(
        svg("line", {
          key: `seam`,
          x1: W / 2,
          x2: W / 2,
          y1: `0`,
          y2: H,
          stroke: shade(spec.base, -0.12),
          strokeWidth: `0.6`,
        }),
      );
    } else {
      i.push(svg("g", { key: `veins` }, e));
    }
  }
  if (spec.variant === `kota` || spec.variant === `slate`) {
    let e = spec.variant === `kota` ? 54 : 58;
    let r2 = spec.variant === `kota` ? 54 : 38;
    for (let a = 0; a < H; a += r2) {
      for (let o = 0; o < W; o += e) {
        i.push(
          svg("rect", {
            key: `t` + o + `-` + a,
            x: o,
            y: a,
            width: e,
            height: r2,
            fill: mixHex(spec.base, spec.vein, random() * 0.7),
            opacity: `0.7`,
          }),
        );
      }
    }
    for (let e2 = r2; e2 < H; e2 += r2) {
      i.push(
        svg("line", {
          key: `hy` + e2,
          x1: `0`,
          x2: W,
          y1: e2,
          y2: e2,
          stroke:
            spec.variant === `kota`
              ? shade(spec.base, 0.35)
              : shade(spec.base, -0.4),
          strokeWidth: `0.8`,
        }),
      );
    }
    for (let n = e; n < W; n += e) {
      i.push(
        svg("line", {
          key: `vx` + n,
          x1: n,
          x2: n,
          y1: `0`,
          y2: H,
          stroke:
            spec.variant === `kota`
              ? shade(spec.base, 0.35)
              : shade(spec.base, -0.4),
          strokeWidth: `0.8`,
        }),
      );
    }
  }
  if (spec.variant === `stacked`) {
    let e = 0;
    while (e < H) {
      let r2 = 5 + random() * 6;
      let a = -random() * 30;
      while (a < W) {
        let o = 18 + random() * 40;
        i.push(
          svg("rect", {
            key: `s` + e.toFixed(1) + a.toFixed(1),
            x: a,
            y: e,
            width: o - 1,
            height: r2 - 1.2,
            fill: mixHex(spec.base, spec.vein, random() * 0.8),
          }),
        );
        a += o;
      }
      e += r2;
    }
  }
  return svg(
    "g",
    null,
    svg("filter", { id: r }, svg("feGaussianBlur", { stdDeviation: `0.45` })),
    svg("rect", {
      width: W,
      height: H,
      fill: spec.variant === `stacked` ? `#2b2824` : spec.base,
    }),
    spec.variant !== `stacked` &&
      CloudTiled(props, {
        id: props.uid + `c`,
        seed: props.seedNumber,
        light: 0.4,
        dark: spec.variant === `marble` ? 0.08 : 0.25,
        frequency: 0.02,
      }),
    i,
    svg(Grain, {
      id: props.uid + `n`,
      opacity: spec.variant === `slate` ? 0.2 : 0.06,
    }),
    (spec.variant === `marble` || spec.variant === `bookmatch`) &&
      SheenMaybe(props, { id: props.uid + `s`, strength: 0.22 }),
  );
}
function TerrazzoSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let r = [];
  for (let e = 0; e < 150; e += 1) {
    let i = random() * W;
    let a = random() * H;
    let o = 0.8 + random() * 3.6;
    let s = 3 + Math.floor(random() * 3);
    let c = [];
    for (let e2 = 0; e2 < s; e2 += 1) {
      let t = (e2 / s) * Math.PI * 2 + random();
      let r2 = o * (0.6 + random() * 0.5);
      c.push(
        (i + Math.cos(t) * r2).toFixed(1) +
          `,` +
          (a + Math.sin(t) * r2).toFixed(1),
      );
    }
    r.push(
      svg("polygon", {
        key: e,
        points: c.join(` `),
        fill: spec.chips[Math.floor(random() * spec.chips.length)],
        opacity: `0.92`,
      }),
    );
  }
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: spec.base }),
    r,
    svg("line", {
      x1: `0`,
      x2: W,
      y1: H * 0.7,
      y2: H * 0.7,
      stroke: `#B89A5E`,
      strokeWidth: `1`,
    }),
    svg(Grain, { id: props.uid + `n`, opacity: 0.06 }),
    SheenMaybe(props, { id: props.uid + `s`, strength: 0.2 }),
  );
}
function TileSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let colors = spec.colors;
  let i = [];
  if (spec.pattern === `checker`) {
    for (let e = -6; e < 12; e += 1) {
      for (let t = -6; t < 12; t += 1) {
        i.push(
          svg("rect", {
            key: e + `-` + t,
            x: t * 20,
            y: e * 20,
            width: 20,
            height: 20,
            fill: (e + t) % 2 == 0 ? colors[0] : colors[1],
          }),
        );
      }
    }
    return svg(
      "g",
      null,
      svg("g", { transform: `translate(80 56) rotate(45)` }, i),
      SheenMaybe(props, { id: props.uid + `s`, strength: 0.18 }),
    );
  }
  if (spec.pattern === `porcelain`) {
    for (let e = 0; e < H; e += 36) {
      for (let t = (e / 36) % 2 == 0 ? 0 : -36; t < W; t += 72) {
        i.push(
          svg("rect", {
            key: t + `-` + e,
            x: t + 0.6,
            y: e + 0.6,
            width: `70.8`,
            height: `34.8`,
            fill: mixHex(colors[0], colors[1], random()),
          }),
        );
      }
    }
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: shade(colors[0], 0.3) }),
      i,
      CloudTiled(props, {
        id: props.uid + `c`,
        seed: props.seedNumber,
        light: 0.25,
        dark: 0.12,
        frequency: 0.025,
      }),
      svg(Grain, { id: props.uid + `n`, opacity: 0.06 }),
    );
  }
  if (spec.pattern === `athangudi`) {
    for (let e = 0; e < H; e += 40) {
      for (let t = 0; t < W; t += 40) {
        i.push(
          svg(
            "g",
            { key: t + `-` + e, transform: `translate(` + t + ` ` + e + `)` },
            svg("rect", {
              width: 40,
              height: 40,
              fill: colors[0],
              stroke: shade(colors[0], -0.3),
              strokeWidth: `0.8`,
            }),
            svg("path", {
              d: `M0 0 h12 a12 12 0 0 1 -12 12 z`,
              fill: colors[1],
            }),
            svg("path", {
              d: `M40 0 v12 a12 12 0 0 1 -12 -12 z`,
              fill: colors[1],
            }),
            svg("path", {
              d: `M0 40 v-12 a12 12 0 0 1 12 12 z`,
              fill: colors[1],
            }),
            svg("path", {
              d: `M40 40 h-12 a12 12 0 0 1 12 -12 z`,
              fill: colors[1],
            }),
            svg("ellipse", {
              cx: `20`,
              cy: `11`,
              rx: `4`,
              ry: `7`,
              fill: colors[2],
            }),
            svg("ellipse", {
              cx: `20`,
              cy: `29`,
              rx: `4`,
              ry: `7`,
              fill: colors[2],
            }),
            svg("ellipse", {
              cx: `11`,
              cy: `20`,
              rx: `7`,
              ry: `4`,
              fill: colors[2],
            }),
            svg("ellipse", {
              cx: `29`,
              cy: `20`,
              rx: `7`,
              ry: `4`,
              fill: colors[2],
            }),
            svg("circle", { cx: `20`, cy: `20`, r: `3.5`, fill: colors[1] }),
          ),
        );
      }
    }
    return svg(
      "g",
      null,
      i,
      svg(Grain, { id: props.uid + `n`, opacity: 0.08 }),
      SheenMaybe(props, { id: props.uid + `s`, strength: 0.16 }),
    );
  }
  for (let e = 0; e <= H; e += 32) {
    for (let t = 0; t <= W; t += 32) {
      i.push(
        svg(
          "g",
          { key: t + `-` + e, transform: `translate(` + t + ` ` + e + `)` },
          svg("circle", { cx: `0`, cy: `16`, r: `9`, fill: colors[1] }),
          svg("circle", { cx: `32`, cy: `16`, r: `9`, fill: colors[1] }),
          svg("circle", { cx: `16`, cy: `0`, r: `9`, fill: colors[1] }),
          svg("circle", { cx: `16`, cy: `32`, r: `9`, fill: colors[1] }),
          svg("rect", {
            x: `12`,
            y: `12`,
            width: `8`,
            height: `8`,
            transform: `rotate(45 16 16)`,
            fill: colors[2],
          }),
        ),
      );
    }
  }
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: colors[0] }),
    i,
    svg(Grain, { id: props.uid + `n`, opacity: 0.1 }),
  );
}
function BrickSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let r = [];
  for (let e = 0; e * 10 < H; e += 1) {
    let i = e % 2 == 0 ? 0 : -14;
    for (let a = i; a < W; a += 28) {
      r.push(
        svg("rect", {
          key: e + `-` + a,
          x: a + 0.9,
          y: e * 10 + 0.9,
          width: 26.2,
          height: 8.2,
          fill: mixHex(
            spec.base,
            random() > 0.5 ? `#3a2018` : `#d0a080`,
            random() * 0.35,
          ),
          rx: `0.6`,
        }),
      );
    }
  }
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: spec.mortar }),
    r,
    svg(Grain, { id: props.uid + `n`, opacity: 0.16 }),
  );
}
function WallpaperSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let colors = spec.colors;
  let i = [];
  if (spec.pattern === `botanical`) {
    for (let e = 0; e < 16; e += 1) {
      let t = random() * W;
      let a = random() * H;
      let o = random() * 360;
      let x2 = 26 + random() * 26;
      let c = e % 2 == 0 ? colors[1] : colors[2];
      i.push(
        svg(
          "g",
          {
            key: e,
            transform:
              `translate(` +
              t.toFixed(1) +
              ` ` +
              a.toFixed(1) +
              `) rotate(` +
              o.toFixed(0) +
              `)`,
          },
          svg("path", {
            d:
              `M0 0 Q ` +
              x2 * 0.5 +
              ` ` +
              -x2 * 0.32 +
              ` ` +
              x2 +
              ` 0 Q ` +
              x2 * 0.5 +
              ` ` +
              x2 * 0.32 +
              ` 0 0 Z`,
            fill: c,
          }),
          svg("line", {
            x1: `0`,
            y1: `0`,
            x2,
            y2: `0`,
            stroke: colors[0],
            strokeOpacity: `0.55`,
            strokeWidth: `0.8`,
          }),
        ),
      );
    }
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: colors[0] }),
      i,
      svg(Grain, { id: props.uid + `n`, opacity: 0.08 }),
    );
  }
  if (spec.pattern === `deco`) {
    for (let e = 0; e < 8; e += 1) {
      for (let t = -1; t < 9; t += 1) {
        let n = t * 22 + (e % 2 == 0 ? 0 : 11);
        let a = e * 14 + 14;
        for (let o = 1; o <= 3; o += 1) {
          let s = o * 3.6;
          i.push(
            svg("path", {
              key: e + `-` + t + `-` + o,
              d:
                `M` +
                (n - s) +
                ` ` +
                a +
                ` A ` +
                s +
                ` ` +
                s +
                ` 0 0 1 ` +
                (n + s) +
                ` ` +
                a,
              stroke: colors[1],
              strokeWidth: `0.9`,
              fill: `none`,
            }),
          );
        }
      }
    }
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: colors[0] }),
      i,
    );
  }
  if (spec.pattern === `buti`) {
    for (let e = 0; e < 6; e += 1) {
      for (let t = 0; t < 8; t += 1) {
        let n = t * 22 + (e % 2 == 0 ? 6 : 17);
        let a = e * 20 + 10;
        i.push(
          svg(
            "g",
            { key: e + `-` + t, transform: `translate(` + n + ` ` + a + `)` },
            svg("ellipse", {
              cx: `-4`,
              cy: `3`,
              rx: `3`,
              ry: `1.4`,
              fill: colors[2],
              transform: `rotate(-30 -4 3)`,
            }),
            svg("ellipse", {
              cx: `4`,
              cy: `3`,
              rx: `3`,
              ry: `1.4`,
              fill: colors[2],
              transform: `rotate(30 4 3)`,
            }),
            svg("circle", { cx: `0`, cy: `-3`, r: `1.7`, fill: colors[1] }),
            svg("circle", {
              cx: `-2.4`,
              cy: `-0.8`,
              r: `1.7`,
              fill: colors[1],
            }),
            svg("circle", { cx: `2.4`, cy: `-0.8`, r: `1.7`, fill: colors[1] }),
            svg("circle", { cx: `0`, cy: `-1.3`, r: `0.9`, fill: colors[0] }),
          ),
        );
      }
    }
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: colors[0] }),
      i,
      svg(Grain, { id: props.uid + `n`, opacity: 0.08 }),
    );
  }
  if (spec.pattern === `damask`) {
    for (let e = -1; e < 4; e += 1) {
      for (let t = -1; t < 5; t += 1) {
        let n = t * 40 + (e % 2 == 0 ? 0 : 20);
        let a = e * 36;
        i.push(
          svg(
            "g",
            {
              key: e + `-` + t,
              transform: `translate(` + n + ` ` + a + `)`,
              fill: colors[1],
            },
            svg("path", {
              d: `M20 4 C 30 12, 30 24, 20 32 C 10 24, 10 12, 20 4 Z`,
            }),
            svg("circle", { cx: `20`, cy: `18`, r: `3`, fill: colors[0] }),
            svg("path", {
              d: `M20 32 C 24 34, 26 38, 20 40 C 14 38, 16 34, 20 32 Z`,
            }),
          ),
        );
      }
    }
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: colors[0] }),
      i,
      SheenMaybe(props, { id: props.uid + `s`, strength: 0.15 }),
    );
  }
  if (spec.pattern === `pinstripe`) {
    for (let e = 4; e < W; e += 8) {
      i.push(
        svg("line", {
          key: e,
          x1: e,
          x2: e,
          y1: `0`,
          y2: H,
          stroke: colors[1],
          strokeWidth: `0.8`,
        }),
      );
    }
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: colors[0] }),
      i,
      svg(Grain, { id: props.uid + `n`, opacity: 0.05 }),
    );
  }
  for (let e = 0; e < H; e += 1.6) {
    i.push(
      svg("line", {
        key: e.toFixed(1),
        x1: `0`,
        x2: W,
        y1: e,
        y2: e + (random() - 0.5),
        stroke: mixHex(colors[0], colors[1], random()),
        strokeWidth: 0.8 + random(),
        strokeOpacity: `0.8`,
      }),
    );
  }
  i.push(
    svg("line", {
      key: `seam`,
      x1: W * 0.62,
      x2: W * 0.62,
      y1: `0`,
      y2: H,
      stroke: shade(colors[1], -0.3),
      strokeWidth: `0.8`,
    }),
  );
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: colors[0] }),
    i,
    svg(Grain, { id: props.uid + `n`, opacity: 0.12 }),
  );
}
function LatticeSwatch(props) {
  let spec = props.spec;
  let n = props.uid + `m`;
  let r = [];
  for (let e = 0; e <= 138; e += 26) {
    for (let t = 0; t <= 186; t += 26) {
      r.push(
        svg("rect", {
          key: `a` + t + e,
          x: t - 6,
          y: e - 6,
          width: `12`,
          height: `12`,
          fill: `#000`,
        }),
      );
      r.push(
        svg("rect", {
          key: `b` + t + e,
          x: t - 6,
          y: e - 6,
          width: `12`,
          height: `12`,
          fill: `#000`,
          transform: `rotate(45 ` + t + ` ` + e + `)`,
        }),
      );
      r.push(
        svg("circle", {
          key: `c` + t + e,
          cx: t + 13,
          cy: e + 13,
          r: `3`,
          fill: `#000`,
        }),
      );
    }
  }
  return svg(
    "g",
    null,
    svg(
      "radialGradient",
      { id: props.uid + `g` },
      svg("stop", { offset: `0`, stopColor: `#F3C887` }),
      svg("stop", { offset: `1`, stopColor: spec.bg }),
    ),
    svg(
      "mask",
      { id: n },
      svg("rect", { width: W, height: H, fill: `#fff` }),
      r,
    ),
    svg("rect", { width: W, height: H, fill: `url(#` + props.uid + `g)` }),
    svg("rect", {
      width: W,
      height: H,
      fill: spec.base,
      mask: `url(#` + n + `)`,
    }),
    svg(Grain, { id: props.uid + `n`, opacity: 0.06 }),
  );
}
function CaneSwatch(props) {
  let spec = props.spec;
  let n = [];
  for (let e = -112; e < 272; e += 6) {
    n.push(
      svg("line", {
        key: `a` + e,
        x1: e,
        y1: `0`,
        x2: e + H,
        y2: H,
        stroke: shade(spec.base, -0.25),
        strokeWidth: `1.6`,
      }),
    );
    n.push(
      svg("line", {
        key: `b` + e,
        x1: e + H,
        y1: `0`,
        x2: e,
        y2: H,
        stroke: shade(spec.base, -0.15),
        strokeWidth: `1.6`,
      }),
    );
  }
  for (let e = 0; e < W; e += 6) {
    n.push(
      svg("line", {
        key: `v` + e,
        x1: e,
        x2: e,
        y1: `0`,
        y2: H,
        stroke: shade(spec.base, 0.15),
        strokeWidth: `1.2`,
      }),
    );
  }
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: shade(spec.base, -0.5) }),
    n,
    svg("rect", {
      x: `4`,
      y: `4`,
      width: 152,
      height: 104,
      fill: `none`,
      stroke: spec.frame,
      strokeWidth: `9`,
    }),
    svg(Grain, { id: props.uid + `n`, opacity: 0.08 }),
  );
}
function FabricSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let r = [];
  if (spec.variant === `velvet`) {
    return svg(
      "g",
      null,
      svg(
        "radialGradient",
        { id: props.uid + `v`, cx: `0.35`, cy: `0.3`, r: `0.9` },
        svg("stop", { offset: `0`, stopColor: shade(spec.base, 0.28) }),
        svg("stop", { offset: `0.6`, stopColor: spec.base }),
        svg("stop", { offset: `1`, stopColor: shade(spec.base, -0.35) }),
      ),
      svg("rect", { width: W, height: H, fill: `url(#` + props.uid + `v)` }),
      svg(Grain, { id: props.uid + `n`, opacity: 0.1, frequency: 1.2 }),
    );
  }
  if (spec.variant === `boucle`) {
    for (let e = 0; e < 420; e += 1) {
      r.push(
        svg("circle", {
          key: e,
          cx: random() * W,
          cy: random() * H,
          r: 1 + random() * 1.6,
          fill: `none`,
          stroke:
            random() > 0.5 ? shade(spec.base, 0.35) : shade(spec.base, -0.18),
          strokeWidth: `0.8`,
        }),
      );
    }
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: spec.base }),
      r,
    );
  }
  if (spec.variant === `leather`) {
    for (let e = 0; e < 6; e += 1) {
      let i = random() * H;
      r.push(
        svg("path", {
          key: e,
          d:
            `M0 ` +
            i +
            ` Q 80 ` +
            (i + (random() - 0.5) * 20) +
            ` 160 ` +
            (i + (random() - 0.5) * 10),
          stroke: shade(spec.base, -0.3),
          strokeOpacity: `0.3`,
          fill: `none`,
        }),
      );
    }
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: spec.base }),
      CloudTiled(props, {
        id: props.uid + `c`,
        seed: props.seedNumber,
        light: 0.25,
        dark: 0.35,
        frequency: 0.03,
      }),
      r,
      SheenMaybe(props, { id: props.uid + `s`, strength: 0.25 }),
    );
  }
  if (spec.variant === `ikat`) {
    for (let t = 0; t < 4; t += 1) {
      for (let n = 0; n < 5; n += 1) {
        let i = n * 36 + (t % 2 == 0 ? 0 : 18);
        let a = t * 32;
        r.push(
          svg("path", {
            key: t + `-` + n,
            d:
              `M` +
              i +
              ` ` +
              (a + 16) +
              ` L` +
              (i + 12) +
              ` ` +
              a +
              ` L` +
              (i + 24) +
              ` ` +
              (a + 16) +
              ` L` +
              (i + 12) +
              ` ` +
              (a + 32) +
              ` Z`,
            fill: `#EEE6D6`,
            filter: `url(#` + props.uid + `b)`,
          }),
        );
      }
    }
    return svg(
      "g",
      null,
      svg(
        "filter",
        { id: props.uid + `b` },
        svg("feGaussianBlur", { stdDeviation: `1.1 0.2` }),
      ),
      svg("rect", { width: W, height: H, fill: spec.base }),
      r,
      svg(Grain, { id: props.uid + `n`, opacity: 0.12 }),
    );
  }
  if (spec.variant === `sheer`) {
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: `#DDE7EA` }),
      svg(
        "linearGradient",
        {
          id: props.uid + `f`,
          x1: `0`,
          y1: `0`,
          x2: `0.12`,
          y2: `0`,
          spreadMethod: `reflect`,
        },
        svg("stop", { offset: `0`, stopColor: spec.base, stopOpacity: `0.55` }),
        svg("stop", { offset: `1`, stopColor: `#ffffff`, stopOpacity: `0.85` }),
      ),
      svg("rect", { width: W, height: H, fill: `url(#` + props.uid + `f)` }),
    );
  }
  for (let e = 0; e < H; e += 2) {
    r.push(
      svg("line", {
        key: `h` + e,
        x1: `0`,
        x2: W,
        y1: e,
        y2: e,
        stroke: shade(spec.base, random() > 0.5 ? -0.12 : 0.12),
        strokeOpacity: `0.5`,
        strokeWidth: 0.6 + random() * 0.6,
      }),
    );
  }
  for (let e = 0; e < W; e += 2) {
    r.push(
      svg("line", {
        key: `v` + e,
        x1: e,
        x2: e,
        y1: `0`,
        y2: H,
        stroke: shade(spec.base, -0.1),
        strokeOpacity: `0.25`,
        strokeWidth: `0.6`,
      }),
    );
  }
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: spec.base }),
    r,
    svg(Grain, { id: props.uid + `n`, opacity: 0.08 }),
  );
}
function RugSwatch(props) {
  let spec = props.spec;
  let random = props.random;
  let colors = spec.colors;
  let i = [];
  if (spec.variant === `jute`) {
    for (let e = 0; e < H; e += 8) {
      for (let t = 0; t < W; t += 8) {
        let a = ((t + e) / 8) % 2 == 0;
        for (let o = 0; o < 3; o += 1) {
          if (a) {
            i.push(
              svg("rect", {
                key: t + `-` + e + `-` + o,
                x: t,
                y: e + o * 2.6,
                width: `8`,
                height: `2.2`,
                rx: `1`,
                fill: mixHex(colors[0], colors[1], random()),
              }),
            );
          } else {
            i.push(
              svg("rect", {
                key: t + `-` + e + `-` + o,
                x: t + o * 2.6,
                y: e,
                width: `2.2`,
                height: `8`,
                rx: `1`,
                fill: mixHex(colors[0], colors[1], random()),
              }),
            );
          }
        }
      }
    }
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: shade(colors[1], -0.3) }),
      i,
    );
  }
  if (spec.variant === `persian`) {
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: colors[0] }),
      svg("rect", {
        x: `6`,
        y: `6`,
        width: 148,
        height: 100,
        fill: `none`,
        stroke: colors[1],
        strokeWidth: `9`,
      }),
      svg("rect", {
        x: `12`,
        y: `12`,
        width: 136,
        height: 88,
        fill: `none`,
        stroke: colors[2],
        strokeWidth: `1.2`,
        strokeDasharray: `3 2`,
      }),
      svg("path", { d: `M80 26 L114 56 L80 86 L46 56 Z`, fill: colors[1] }),
      svg("path", { d: `M80 38 L100 56 L80 74 L60 56 Z`, fill: colors[2] }),
      svg("circle", { cx: W / 2, cy: H / 2, r: `5`, fill: colors[0] }),
      svg(Grain, { id: props.uid + `n`, opacity: 0.22, frequency: 1.1 }),
    );
  }
  if (spec.variant === `dhurrie`) {
    [16, 22, 52, 58, 88, 94].forEach((e, t2) => {
      i.push(
        svg("rect", {
          key: `b` + e,
          x: `0`,
          y: e,
          width: W,
          height: t2 % 2 == 0 ? 5 : 3,
          fill: t2 % 2 == 0 ? colors[1] : colors[2],
        }),
      );
    });
    let t = `M0 40`;
    for (let e = 0; e <= W; e += 10) {
      t += ` L` + e + ` ` + (e % 20 == 0 ? 34 : 44);
    }
    i.push(
      svg("path", {
        key: `zig`,
        d: t,
        stroke: colors[1],
        strokeWidth: `2`,
        fill: `none`,
      }),
    );
    return svg(
      "g",
      null,
      svg("rect", { width: W, height: H, fill: colors[0] }),
      i,
      svg(Grain, { id: props.uid + `n`, opacity: 0.14 }),
    );
  }
  for (let e = 0; e < 700; e += 1) {
    let x1 = random() * W;
    let a = random() * H;
    let o = random() * Math.PI * 2;
    i.push(
      svg("line", {
        key: e,
        x1,
        y1: a,
        x2: x1 + Math.cos(o) * 4,
        y2: a + Math.sin(o) * 4,
        stroke: random() > 0.5 ? colors[0] : colors[1],
        strokeWidth: `1.4`,
        strokeLinecap: `round`,
      }),
    );
  }
  return svg(
    "g",
    null,
    svg("rect", { width: W, height: H, fill: colors[1] }),
    i,
  );
}
function Glow(props) {
  return svg(
    "g",
    null,
    svg(
      "radialGradient",
      { id: props.id },
      svg("stop", {
        offset: `0`,
        stopColor: props.color || `#F6D28C`,
        stopOpacity: props.opacity || 0.85,
      }),
      svg("stop", {
        offset: `1`,
        stopColor: props.color || `#F6D28C`,
        stopOpacity: `0`,
      }),
    ),
    svg("circle", {
      cx: props.x,
      cy: props.y,
      r: props.r,
      fill: `url(#` + props.id + `)`,
    }),
  );
}
function DoorMotif(props) {
  const ink = props.ink;
  const base = props.base;
  const name = props.name;
  let i = [];
  if (name === `door-panel` || name === `door-carved`) {
    for (let e = 0; e < 3; e += 1) {
      for (let n = 0; n < 2; n += 1) {
        i.push(
          svg("rect", {
            key: e + `-` + n,
            x: 62 + n * 19,
            y: 18 + e * 27,
            width: `15`,
            height: `23`,
            fill: `none`,
            stroke: ink,
            strokeWidth: `1.4`,
          }),
        );
        if (name === `door-carved`) {
          i.push(
            svg("circle", {
              key: `c` + e + `-` + n,
              cx: 69.5 + n * 19,
              cy: 29.5 + e * 27,
              r: `4`,
              fill: `none`,
              stroke: ink,
              strokeWidth: `1`,
            }),
          );
          i.push(
            svg("circle", {
              key: `s` + e + `-` + n,
              cx: 69.5 + n * 19,
              cy: 29.5 + e * 27,
              r: `1.2`,
              fill: `#C9A45F`,
            }),
          );
        }
      }
    }
  }
  if (name === `door-shaker`) {
    i.push(
      svg("rect", {
        key: `a`,
        x: `62`,
        y: `18`,
        width: `34`,
        height: `38`,
        fill: `none`,
        stroke: ink,
        strokeWidth: `2`,
      }),
    );
    i.push(
      svg("rect", {
        key: `b`,
        x: `62`,
        y: `62`,
        width: `34`,
        height: `38`,
        fill: `none`,
        stroke: ink,
        strokeWidth: `2`,
      }),
    );
  }
  if (name === `door-fluted`) {
    for (let e = 60; e < 98; e += 3) {
      i.push(
        svg("line", {
          key: e,
          x1: e,
          x2: e,
          y1: `14`,
          y2: `102`,
          stroke: `#ffffff`,
          strokeOpacity: `0.55`,
          strokeWidth: `1.2`,
        }),
      );
    }
  }
  return svg(
    "g",
    null,
    svg("rect", {
      x: `55`,
      y: `10`,
      width: `48`,
      height: `96`,
      fill: base,
      stroke: name === `door-fluted` ? ink : shade(base, -0.3),
      strokeWidth: name === `door-fluted` ? 3 : 1,
    }),
    i,
    name === `door-flush`
      ? svg("rect", { x: `94`, y: `40`, width: `2.6`, height: `34`, fill: ink })
      : svg("circle", { cx: `96`, cy: `60`, r: `2.2`, fill: `#C9A45F` }),
  );
}
function MotifSwatch(props) {
  const spec = props.spec;
  const uid = props.uid;
  let spec_ink = spec.ink;
  let spec_base = spec.base;
  let spec_name = spec.name;
  let o = [];
  if (spec_name.indexOf(`door-`) === 0) {
    o.push(svg("rect", { key: `wall`, width: W, height: H, fill: `#E4DED3` }));
    o.push(
      svg(DoorMotif, {
        key: `door`,
        name: spec_name,
        base: spec_base,
        ink: spec_ink,
      }),
    );
  } else if (spec_name === `tvunit`) {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    for (let e = 34; e < 126; e += 3.2) {
      o.push(
        svg("line", {
          key: `f` + e,
          x1: e,
          x2: e,
          y1: `10`,
          y2: `86`,
          stroke: `#9A7650`,
          strokeWidth: `2.2`,
        }),
      );
    }
    o.push(
      svg("rect", {
        key: `tv`,
        x: `46`,
        y: `26`,
        width: `68`,
        height: `38`,
        rx: `1.5`,
        fill: spec_ink,
      }),
    );
    o.push(
      svg("rect", {
        key: `console`,
        x: `22`,
        y: `88`,
        width: `116`,
        height: `10`,
        fill: `#8C6A47`,
      }),
    );
    o.push(
      svg("rect", {
        key: `shadow`,
        x: `24`,
        y: `98`,
        width: `112`,
        height: `3`,
        fill: `#000`,
        opacity: `0.15`,
      }),
    );
  } else if (spec_name === `frames`) {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    [
      [20, 16, 30, 40],
      [56, 16, 44, 28],
      [106, 16, 34, 46],
      [56, 50, 22, 28],
      [84, 50, 16, 20],
      [20, 62, 30, 30],
      [106, 68, 34, 24],
    ].forEach((e, t) => {
      o.push(
        svg("rect", {
          key: `o` + t,
          x: e[0],
          y: e[1],
          width: e[2],
          height: e[3],
          fill: `#F6F2EA`,
          stroke: t % 3 == 0 ? `#9A6E45` : spec_ink,
          strokeWidth: `2.2`,
        }),
      );
      o.push(
        svg("rect", {
          key: `i` + t,
          x: e[0] + 5,
          y: e[1] + 5,
          width: e[2] - 10,
          height: e[3] - 10,
          fill: [`#B5694D`, `#7D998A`, `#C99A3E`, `#34476B`][t % 4],
          opacity: `0.75`,
        }),
      );
    });
  } else if (spec_name === `canvas`) {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    o.push(
      svg("rect", {
        key: `c`,
        x: `28`,
        y: `14`,
        width: `104`,
        height: `78`,
        fill: `#F0E8DA`,
        stroke: `#D2C7B4`,
      }),
    );
    o.push(
      svg("path", {
        key: `a`,
        d: `M34 70 Q 60 30 90 54 T 128 38 L 128 88 L 34 88 Z`,
        fill: spec_ink,
        opacity: `0.85`,
      }),
    );
    o.push(
      svg("circle", {
        key: `b`,
        cx: `96`,
        cy: `34`,
        r: `12`,
        fill: `#C99A3E`,
        opacity: `0.85`,
      }),
    );
    o.push(
      svg("path", {
        key: `d`,
        d: `M34 52 Q 52 46 66 60`,
        stroke: `#3E3E40`,
        strokeWidth: `3`,
        fill: `none`,
      }),
    );
  } else if (spec_name === `pichwai`) {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    o.push(
      svg("rect", {
        key: `f`,
        x: `24`,
        y: `10`,
        width: `112`,
        height: `90`,
        fill: spec_ink,
        stroke: `#C9A45F`,
        strokeWidth: `3`,
      }),
    );
    for (let e = 0; e < 9; e += 1) {
      let t = 38 + (e % 3) * 42 + (Math.floor(e / 3) % 2) * 10;
      let cy = 26 + Math.floor(e / 3) * 26;
      o.push(
        svg("circle", { key: `l` + e, cx: t, cy, r: `6`, fill: `#E59AA6` }),
      );
      o.push(
        svg("circle", { key: `m` + e, cx: t, cy, r: `2.2`, fill: `#F6D9A6` }),
      );
      o.push(
        svg("ellipse", {
          key: `p` + e,
          cx: t + 8,
          cy: cy + 6,
          rx: `7`,
          ry: `3`,
          fill: `#4F7A5C`,
        }),
      );
    }
  } else if (spec_name === `mirror`) {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    o.push(
      svg(
        "linearGradient",
        {
          key: `g`,
          id: uid + `mg`,
          x1: `0`,
          y1: `0`,
          x2: `1`,
          y2: `1`,
        },
        svg("stop", { offset: `0`, stopColor: `#E9EEF0` }),
        svg("stop", { offset: `0.5`, stopColor: `#B8C3C7` }),
        svg("stop", { offset: `1`, stopColor: `#DCE3E5` }),
      ),
    );
    o.push(
      svg("circle", {
        key: `m`,
        cx: W / 2,
        cy: H / 2,
        r: `40`,
        fill: `url(#` + uid + `mg)`,
        stroke: spec_ink,
        strokeWidth: `4`,
      }),
    );
    o.push(
      svg("line", {
        key: `r`,
        x1: `62`,
        y1: `44`,
        x2: `78`,
        y2: `28`,
        stroke: `#fff`,
        strokeOpacity: `0.7`,
        strokeWidth: `3`,
      }),
    );
  } else if (spec_name === `shelves`) {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    [
      [20, 34, 70],
      [60, 62, 80],
      [30, 90, 74],
    ].forEach((e, t) => {
      o.push(
        svg("rect", {
          key: `s` + t,
          x: e[0],
          y: e[1],
          width: e[2],
          height: `5`,
          fill: spec_ink,
        }),
      );
      o.push(
        svg("rect", {
          key: `sh` + t,
          x: e[0],
          y: e[1] + 5,
          width: e[2],
          height: `4`,
          fill: `#000`,
          opacity: `0.08`,
        }),
      );
      o.push(
        svg("rect", {
          key: `b1` + t,
          x: e[0] + 6,
          y: e[1] - 16,
          width: `5`,
          height: `16`,
          fill: `#34476B`,
        }),
      );
      o.push(
        svg("rect", {
          key: `b2` + t,
          x: e[0] + 12,
          y: e[1] - 13,
          width: `4`,
          height: `13`,
          fill: `#B5694D`,
        }),
      );
      o.push(
        svg("circle", {
          key: `v` + t,
          cx: e[0] + e[2] - 14,
          cy: e[1] - 7,
          r: `7`,
          fill: `#EDE6D8`,
          stroke: `#BFB4A2`,
        }),
      );
    });
  } else if (spec_name === `sconces`) {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    [50, 110].forEach((e, t) => {
      o.push(
        svg(Glow, {
          key: `g` + t,
          id: uid + `sg` + t,
          x: e,
          y: 44,
          r: 34,
          opacity: 0.7,
        }),
      );
      o.push(
        svg("rect", {
          key: `p` + t,
          x: e - 2,
          y: `50`,
          width: `4`,
          height: `12`,
          fill: spec_ink,
        }),
      );
      o.push(
        svg("path", {
          key: `s` + t,
          d:
            `M` +
            (e - 9) +
            ` 50 L` +
            (e - 6) +
            ` 34 L` +
            (e + 6) +
            ` 34 L` +
            (e + 9) +
            ` 50 Z`,
          fill: `#F5EEDF`,
          stroke: spec_ink,
          strokeWidth: `1`,
        }),
      );
    });
  } else if (
    spec_name === `cove` ||
    spec_name === `tray` ||
    spec_name === `floating` ||
    spec_name === `coffered` ||
    spec_name === `beams`
  ) {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    if (spec_name === `cove`) {
      o.push(
        svg(
          "linearGradient",
          {
            key: `g`,
            id: uid + `cg`,
            x1: `0`,
            y1: `0`,
            x2: `0`,
            y2: `1`,
          },
          svg("stop", { offset: `0`, stopColor: spec_ink, stopOpacity: `0.9` }),
          svg("stop", { offset: `1`, stopColor: spec_ink, stopOpacity: `0` }),
        ),
      );
      o.push(
        svg("rect", {
          key: `o`,
          x: `14`,
          y: `12`,
          width: `132`,
          height: `88`,
          fill: `none`,
          stroke: `#CFC8BC`,
          strokeWidth: `1.2`,
        }),
      );
      o.push(
        svg("rect", {
          key: `t`,
          x: `14`,
          y: `12`,
          width: `132`,
          height: `16`,
          fill: `url(#` + uid + `cg)`,
        }),
      );
      o.push(
        svg("rect", {
          key: `b`,
          x: `14`,
          y: `84`,
          width: `132`,
          height: `16`,
          fill: `url(#` + uid + `cg)`,
          transform: `rotate(180 80 92)`,
        }),
      );
      o.push(
        svg("rect", {
          key: `i`,
          x: `30`,
          y: `28`,
          width: `100`,
          height: `56`,
          fill: spec_base,
          stroke: `#D8D1C5`,
        }),
      );
    }
    if (spec_name === `tray`) {
      o.push(
        svg("rect", {
          key: `o`,
          x: `12`,
          y: `10`,
          width: `136`,
          height: `92`,
          fill: `#E0DBD2`,
        }),
      );
      o.push(
        svg("rect", {
          key: `m`,
          x: `26`,
          y: `22`,
          width: `108`,
          height: `68`,
          fill: `#E8E4DD`,
          stroke: spec_ink,
          strokeOpacity: `0.4`,
        }),
      );
      o.push(
        svg("rect", {
          key: `i`,
          x: `40`,
          y: `34`,
          width: `80`,
          height: `44`,
          fill: `#F2F0EB`,
          stroke: spec_ink,
          strokeOpacity: `0.4`,
        }),
      );
      [20, 80, 140].forEach((cx, t) => {
        o.push(
          svg("circle", {
            key: `d` + t,
            cx,
            cy: `16`,
            r: `2.2`,
            fill: `#F2C77A`,
          }),
        );
      });
    }
    if (spec_name === `floating`) {
      o.push(
        svg("rect", {
          key: `gap`,
          x: `18`,
          y: `14`,
          width: `124`,
          height: `84`,
          fill: `#BDB6AA`,
        }),
      );
      o.push(
        svg("rect", {
          key: `p`,
          x: `22`,
          y: `18`,
          width: `116`,
          height: `76`,
          fill: `#F2F0EB`,
        }),
      );
      o.push(
        svg("rect", {
          key: `l1`,
          x: `34`,
          y: `34`,
          width: `92`,
          height: `3`,
          fill: spec_ink,
        }),
      );
      o.push(
        svg("rect", {
          key: `l2`,
          x: `34`,
          y: `34`,
          width: `3`,
          height: `44`,
          fill: spec_ink,
        }),
      );
      o.push(
        svg("rect", {
          key: `l3`,
          x: `78`,
          y: `54`,
          width: `48`,
          height: `3`,
          fill: spec_ink,
        }),
      );
    }
    if (spec_name === `coffered`) {
      for (let e = 0; e < 3; e += 1) {
        for (let t = 0; t < 4; t += 1) {
          o.push(
            svg("rect", {
              key: e + `-` + t,
              x: 10 + t * 36,
              y: 8 + e * 33,
              width: `32`,
              height: `29`,
              fill: `#F3F1EC`,
              stroke: spec_ink,
              strokeWidth: `1.4`,
            }),
          );
          o.push(
            svg("rect", {
              key: `i` + e + `-` + t,
              x: 15 + t * 36,
              y: 13 + e * 33,
              width: `22`,
              height: `19`,
              fill: `#E2DED6`,
            }),
          );
        }
      }
    }
    if (spec_name === `beams`) {
      for (let e = 0; e < 5; e += 1) {
        let t = 8 + e * 34;
        o.push(
          svg("path", {
            key: e,
            d:
              `M` +
              t +
              ` 0 L` +
              (t + 12) +
              ` 0 L` +
              (t + 16) +
              ` 112 L` +
              (t - 4) +
              ` 112 Z`,
            fill: spec_ink,
          }),
        );
        o.push(
          svg("path", {
            key: `h` + e,
            d:
              `M` +
              (t + 12) +
              ` 0 L` +
              (t + 14) +
              ` 0 L` +
              (t + 18) +
              ` 112 L` +
              (t + 16) +
              ` 112 Z`,
            fill: `#000`,
            opacity: `0.25`,
          }),
        );
      }
    }
  } else if (
    spec_name.indexOf(`pendant`) === 0 ||
    spec_name === `chandelier` ||
    spec_name === `downlights` ||
    spec_name === `track`
  ) {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    if (spec_name === `pendant-rattan`) {
      [
        [44, 52],
        [80, 68],
        [116, 46],
      ].forEach((e, t) => {
        o.push(
          svg("line", {
            key: `c` + t,
            x1: e[0],
            x2: e[0],
            y1: `0`,
            y2: e[1] - 14,
            stroke: `#3B342C`,
            strokeWidth: `0.8`,
          }),
        );
        o.push(
          svg(Glow, {
            key: `g` + t,
            id: uid + `pg` + t,
            x: e[0],
            y: e[1] + 6,
            r: 26,
          }),
        );
        o.push(
          svg("path", {
            key: `d` + t,
            d:
              `M` +
              (e[0] - 16) +
              ` ` +
              e[1] +
              ` A16 16 0 0 1 ` +
              (e[0] + 16) +
              ` ` +
              e[1] +
              ` Z`,
            fill: spec_ink,
          }),
        );
        for (let n = -12; n <= 12; n += 4) {
          o.push(
            svg("line", {
              key: `w` + t + n,
              x1: e[0] + n,
              y1: e[1],
              x2: e[0] + n * 0.4,
              y2: e[1] - 14,
              stroke: `#7E5E36`,
              strokeWidth: `0.7`,
            }),
          );
        }
      });
    }
    if (spec_name === `pendant-glass`) {
      [36, 64, 92, 120].forEach((e, t) => {
        o.push(
          svg("line", {
            key: `c` + t,
            x1: e,
            x2: e,
            y1: `0`,
            y2: `48`,
            stroke: spec_ink,
            strokeWidth: `1.4`,
          }),
        );
        o.push(
          svg(Glow, { key: `g` + t, id: uid + `gg` + t, x: e, y: 58, r: 22 }),
        );
        o.push(
          svg("circle", {
            key: `b` + t,
            cx: e,
            cy: `58`,
            r: `10`,
            fill: `#FAF6EE`,
            stroke: `#E6DCC8`,
          }),
        );
      });
    }
    if (spec_name === `chandelier`) {
      o.push(
        svg(Glow, {
          key: `glow`,
          id: uid + `cg`,
          x: 80,
          y: 56,
          r: 50,
          opacity: 0.6,
        }),
      );
      o.push(
        svg("line", {
          key: `s`,
          x1: `80`,
          x2: `80`,
          y1: `0`,
          y2: `40`,
          stroke: spec_ink,
          strokeWidth: `1.6`,
        }),
      );
      o.push(
        svg("path", {
          key: `a`,
          d: `M44 56 Q 80 76 116 56`,
          stroke: spec_ink,
          strokeWidth: `2`,
          fill: `none`,
        }),
      );
      o.push(
        svg("path", {
          key: `b`,
          d: `M56 48 Q 80 62 104 48`,
          stroke: spec_ink,
          strokeWidth: `1.6`,
          fill: `none`,
        }),
      );
      [44, 62, 80, 98, 116].forEach((e, t) => {
        o.push(
          svg("rect", {
            key: `k` + t,
            x: e - 1.5,
            y: t % 2 == 0 ? 44 : 50,
            width: `3`,
            height: `8`,
            fill: `#F6F0E2`,
          }),
        );
        o.push(
          svg("circle", {
            key: `d` + t,
            cx: e,
            cy: t % 2 == 0 ? 70 : 74,
            r: `2.2`,
            fill: `#E9F0F3`,
            stroke: `#B8C3C7`,
            strokeWidth: `0.5`,
          }),
        );
      });
    }
    if (spec_name === `downlights`) {
      for (let e = 0; e < 3; e += 1) {
        for (let t = 0; t < 4; t += 1) {
          let i = 26 + t * 36;
          let a = 22 + e * 34;
          o.push(
            svg(Glow, {
              key: `g` + e + t,
              id: uid + `dg` + e + t,
              x: i,
              y: a,
              r: 13,
              opacity: 0.6,
              color: spec_ink,
            }),
          );
          o.push(
            svg("circle", {
              key: `d` + e + t,
              cx: i,
              cy: a,
              r: `4`,
              fill: `#FFF8E8`,
              stroke: `#CFC8BC`,
            }),
          );
        }
      }
    }
    if (spec_name === `track`) {
      o.push(
        svg("rect", {
          key: `t`,
          x: `16`,
          y: `24`,
          width: `128`,
          height: `4`,
          fill: spec_ink,
        }),
      );
      [34, 66, 98, 130].forEach((e, t) => {
        o.push(
          svg("rect", {
            key: `s` + t,
            x: e - 4,
            y: `30`,
            width: `8`,
            height: `16`,
            rx: `1.5`,
            fill: spec_ink,
            transform: `rotate(` + (t % 2 == 0 ? -24 : 24) + ` ` + e + ` 30)`,
          }),
        );
        o.push(
          svg(Glow, {
            key: `g` + t,
            id: uid + `tg` + t,
            x: e + (t % 2 == 0 ? 14 : -14),
            y: 78,
            r: 22,
            opacity: 0.5,
          }),
        );
      });
    }
  } else if (
    spec_name === `roman` ||
    spec_name === `venetian` ||
    spec_name === `zebra` ||
    spec_name === `shutters` ||
    spec_name === `chik` ||
    spec_name === `metalframe` ||
    spec_name === `arch`
  ) {
    o.push(svg("rect", { key: `wall`, width: W, height: H, fill: `#E4DED3` }));
    o.push(
      svg("rect", {
        key: `glass`,
        x: `30`,
        y: `10`,
        width: `100`,
        height: `92`,
        fill: `#CFE0E6`,
      }),
    );
    if (spec_name === `roman`) {
      o.push(
        svg("rect", {
          key: `f`,
          x: `30`,
          y: `10`,
          width: `100`,
          height: `52`,
          fill: spec_base,
        }),
      );
      [22, 36, 50].forEach((e, t) => {
        o.push(
          svg("path", {
            key: t,
            d: `M30 ` + e + ` Q 80 ` + (e + 6) + ` 130 ` + e,
            stroke: spec_ink,
            strokeWidth: `1.4`,
            fill: `none`,
          }),
        );
      });
    }
    if (spec_name === `venetian`) {
      for (let e = 12; e < 100; e += 6) {
        o.push(
          svg("rect", {
            key: e,
            x: `30`,
            y: e,
            width: `100`,
            height: `3.6`,
            fill: spec_base,
          }),
        );
        o.push(
          svg("rect", {
            key: `s` + e,
            x: `30`,
            y: e + 3.6,
            width: `100`,
            height: `0.8`,
            fill: spec_ink,
          }),
        );
      }
    }
    if (spec_name === `zebra`) {
      for (let e = 10; e < 102; e += 14) {
        o.push(
          svg("rect", {
            key: e,
            x: `30`,
            y: e,
            width: `100`,
            height: `7`,
            fill: spec_ink,
            opacity: `0.9`,
          }),
        );
        o.push(
          svg("rect", {
            key: `b` + e,
            x: `30`,
            y: e + 7,
            width: `100`,
            height: `7`,
            fill: spec_base,
            opacity: `0.55`,
          }),
        );
      }
    }
    if (spec_name === `shutters`) {
      [30, 80].forEach((e) => {
        o.push(
          svg("rect", {
            key: `p` + e,
            x: e,
            y: `10`,
            width: `50`,
            height: `92`,
            fill: spec_base,
            stroke: spec_ink,
          }),
        );
        for (let t = 16; t < 98; t += 5) {
          o.push(
            svg("rect", {
              key: e + `-` + t,
              x: e + 5,
              y: t,
              width: `40`,
              height: `2.6`,
              fill: spec_ink,
            }),
          );
        }
      });
    }
    if (spec_name === `chik`) {
      o.push(
        svg("rect", {
          key: `b`,
          x: `30`,
          y: `10`,
          width: `100`,
          height: `70`,
          fill: spec_base,
        }),
      );
      for (let e = 11; e < 80; e += 1.8) {
        o.push(
          svg("line", {
            key: e.toFixed(1),
            x1: `30`,
            x2: `130`,
            y1: e,
            y2: e,
            stroke: spec_ink,
            strokeWidth: `0.5`,
          }),
        );
      }
      o.push(
        svg("line", {
          key: `t1`,
          x1: `50`,
          x2: `50`,
          y1: `10`,
          y2: `86`,
          stroke: `#7A2E2A`,
          strokeWidth: `1.2`,
        }),
      );
      o.push(
        svg("line", {
          key: `t2`,
          x1: `110`,
          x2: `110`,
          y1: `10`,
          y2: `86`,
          stroke: `#7A2E2A`,
          strokeWidth: `1.2`,
        }),
      );
    }
    if (spec_name === `metalframe`) {
      o.push(
        svg("rect", {
          key: `o`,
          x: `30`,
          y: `10`,
          width: `100`,
          height: `92`,
          fill: `none`,
          stroke: spec_ink,
          strokeWidth: `3`,
        }),
      );
      [55, 80, 105].forEach((e) => {
        o.push(
          svg("line", {
            key: `v` + e,
            x1: e,
            x2: e,
            y1: `10`,
            y2: `102`,
            stroke: spec_ink,
            strokeWidth: `1.6`,
          }),
        );
      });
      [33, 56, 79].forEach((e) => {
        o.push(
          svg("line", {
            key: `h` + e,
            x1: `30`,
            x2: `130`,
            y1: e,
            y2: e,
            stroke: spec_ink,
            strokeWidth: `1.6`,
          }),
        );
      });
    }
    if (spec_name === `arch`) {
      o.push(
        svg("path", {
          key: `a`,
          d: `M30 102 L30 48 A50 40 0 0 1 130 48 L130 102 Z`,
          fill: `#CFE0E6`,
          stroke: spec_ink,
          strokeWidth: `5`,
        }),
      );
      o.push(
        svg("line", {
          key: `m`,
          x1: `80`,
          x2: `80`,
          y1: `8`,
          y2: `102`,
          stroke: spec_ink,
          strokeWidth: `2.4`,
        }),
      );
      o.push(
        svg("line", {
          key: `h`,
          x1: `30`,
          x2: `130`,
          y1: `48`,
          y2: `48`,
          stroke: spec_ink,
          strokeWidth: `2.4`,
        }),
      );
    }
  } else {
    o.push(svg("rect", { key: `bg`, width: W, height: H, fill: spec_base }));
    o.push(
      svg("rect", {
        key: `r`,
        x: `46`,
        y: `26`,
        width: `68`,
        height: `60`,
        fill: `none`,
        stroke: spec_ink,
        strokeWidth: `1.6`,
        strokeDasharray: `5 4`,
      }),
    );
    o.push(
      svg("line", {
        key: `a`,
        x1: `64`,
        y1: `44`,
        x2: `96`,
        y2: `68`,
        stroke: spec_ink,
        strokeWidth: `2`,
        strokeLinecap: `round`,
      }),
    );
    o.push(
      svg("line", {
        key: `b`,
        x1: `96`,
        y1: `44`,
        x2: `64`,
        y2: `68`,
        stroke: spec_ink,
        strokeWidth: `2`,
        strokeLinecap: `round`,
      }),
    );
  }
  return svg("g", null, o, svg(Grain, { id: uid + `n`, opacity: 0.04 }));
}
const RENDERERS = {
  paint: PaintSwatch,
  plaster: PlasterSwatch,
  wood: WoodSwatch,
  slats: SlatSwatch,
  panel: PanelSwatch,
  stone: StoneSwatch,
  terrazzo: TerrazzoSwatch,
  tile: TileSwatch,
  brick: BrickSwatch,
  wallpaper: WallpaperSwatch,
  lattice: LatticeSwatch,
  cane: CaneSwatch,
  fabric: FabricSwatch,
  rug: RugSwatch,
  motif: MotifSwatch,
};

const markupCache = new Map();

function placeId(text) {
  return "sw" + hashString(text).toString(36);
}

// Makes a pattern's existing 160x112 output tile seamlessly, without touching any pattern's
// own drawing logic: the same content is stamped at the 8 neighbouring tile positions too,
// then clipped back down to the real tile - so anything that pokes past one edge reappears as
// its own continuation on the opposite edge (the standard "offset and wrap" technique for
// turning a one-off illustration into a repeatable tile). Grid-pitched patterns whose pitch
// already divides 160/112 evenly gain nothing from this (harmless - just a few redundant
// extra elements, since they already tile on their own); patterns built from scattered random
// shapes (stone veining, terrazzo chips, loose plaster blobs, a wood plank cut by the edge...)
// are exactly the case this fixes.
function wrapSeamless(uid, content) {
  const clipId = uid + `clip`;
  const contentId = uid + `body`;
  const offsets = [
    [-W, -H],
    [0, -H],
    [W, -H],
    [-W, 0],
    [W, 0],
    [-W, H],
    [0, H],
    [W, H],
  ];
  return svg(
    Fragment,
    null,
    svg("clipPath", { id: clipId }, svg("rect", { width: W, height: H })),
    svg(
      "g",
      { clipPath: `url(#` + clipId + `)` },
      svg("g", { id: contentId }, content),
      offsets.map(function (offset, index) {
        return svg("use", {
          key: `wrap` + index,
          href: `#` + contentId,
          x: offset[0],
          y: offset[1],
        });
      }),
    ),
  );
}

// SVG markup for one swatch card, or (options.forTiling) one physically-tiled catalogue
// texture - same 160x112 pattern either way, just with the corner Sheen vignette skipped and
// wrapSeamless() applied (see scripts/build-textures.js, which rasterizes and upscales the
// forTiling output; the small on-screen cards never pass options at all, so they are
// unaffected). Cached, because drawing some materials takes a while.
export function swatchMarkup(spec, seed, place, options) {
  const forTiling = !!(options && options.forTiling);
  const seedText = seed || "swatch";
  const where = place || "default";
  const cacheKey =
    (forTiling ? "tile|" : "") + where + "|" + seedText + "|" + JSON.stringify(spec);
  const cached = markupCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const Renderer = RENDERERS[spec.type] || PaintSwatch;
  const uid = placeId(where + "|" + seedText);
  const drawing = Renderer({
    spec: spec,
    random: makeRandom(seedText),
    uid: uid,
    seedNumber: (hashString(seedText) % 97) + 1,
    forTiling: forTiling,
  });
  const body = forTiling ? wrapSeamless(uid, drawing) : drawing;
  const markup =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 112" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">' +
    body +
    "</svg>";
  if (markupCache.size > 600) {
    markupCache.clear();
  }
  markupCache.set(cacheKey, markup);
  return markup;
}
