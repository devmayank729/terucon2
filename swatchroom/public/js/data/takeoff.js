// Quantity take-off tables.
// GROUP_SPECS gives every catalog group ("kind/Group") a category name, a quantity rule,
// installation notes and care notes. ITEM_QTY overrides the quantity rule for single items.

export const SQFT_PER_M2 = 10.7639;

export const GROUP_SPECS = {
  "wall/Paint": {
    category: `Interior wall paint`,
    qty: {
      type: `paint`,
      coverage: 11,
      coats: 2,
      primerCoverage: 12,
    },
    install: `Fill cracks and sand, apply one coat of primer, then two finish coats by roller; cut in edges by brush.`,
    care: `Dust and wipe with a damp cloth. Washable emulsions accept mild soap after 30 days.`,
  },
  "wall/Plaster and texture": {
    category: `Decorative wall finish`,
    qty: {
      type: `coating`,
      perM2: 1.5,
      unit: `kg`,
      pack: 20,
    },
    install: `Applied by a specialist applicator over a primed, level plaster base in two to three passes.`,
    care: `Seal in wet areas. Clean with a soft damp cloth; avoid abrasive cleaners.`,
  },
  "wall/Panels and cladding": {
    category: `Wall cladding`,
    qty: {
      type: `panel`,
      panelW: 0.6,
      panelH: 2.8,
      wastage: 0.1,
      unit: `panels`,
    },
    install: `Fixed to a levelled batten frame or directly with panel adhesive; leave expansion gaps at edges.`,
    care: `Dust regularly; wipe with a barely damp cloth. Keep away from direct water.`,
  },
  "wall/Wallpaper": {
    category: `Wallcovering`,
    qty: {
      type: `wallpaper`,
      rollW: 0.53,
      rollL: 10,
      wastage: 0.15,
    },
    install: `Hang on a sealed, smooth wall with paste-the-wall adhesive; match the pattern repeat at each drop.`,
    care: `Wipe gently with a damp sponge. Not for wet areas.`,
  },
  "wall/Add to this wall": {
    category: `Wall decor`,
    qty: {
      type: `count`,
      count: 1,
      unit: `piece`,
    },
    install: `Fix to the wall with anchors rated for the weight; check for concealed wiring before drilling.`,
    care: `Dust with a soft dry cloth.`,
  },
  "floor/Wood": {
    category: `Wood flooring`,
    qty: {
      type: `boxes`,
      boxCoverage: 2.2,
      wastage: 0.08,
      underlay: true,
    },
    install: `Acclimatise boxes for 48 hours, lay over a level screed with underlay, leave 10 mm expansion gaps under skirting.`,
    care: `Sweep or vacuum; clean with a wood floor cleaner. Use felt pads under furniture.`,
  },
  "floor/Stone and tile": {
    category: `Stone and tile flooring`,
    qty: {
      type: `tiles`,
      tileW: 0.6,
      tileH: 0.6,
      perBox: 4,
      wastage: 0.1,
      adhesive: true,
    },
    install: `Lay on a level bed with tile adhesive and spacers; grout after 24 hours and seal natural stone.`,
    care: `Mop with a pH-neutral cleaner. Reseal natural stone every 1 to 2 years.`,
  },
  "floor/Seamless": {
    category: `Seamless flooring`,
    qty: {
      type: `coating`,
      perM2: 1.8,
      unit: `kg`,
      pack: 20,
    },
    install: `Specialist system: primer, mesh, base and finish coats, then sealer. Allow 3 to 7 days before use.`,
    care: `Mop with a neutral cleaner. Avoid dragging heavy furniture.`,
  },
  "floor/Add a rug": {
    category: `Rug`,
    qty: {
      type: `rug`,
    },
    install: `Place so the front legs of the main seating rest on the rug. Use a non-slip underlay on hard floors.`,
    care: `Vacuum weekly; spot clean spills; professional clean once a year.`,
  },
  "ceiling/Finish": {
    category: `Ceiling finish`,
    qty: {
      type: `paint`,
      coverage: 12,
      coats: 2,
      primerCoverage: 12,
    },
    install: `Prime and apply two coats with an extension roller; work away from the main window to hide laps.`,
    care: `Dust occasionally with a soft broom.`,
  },
  "ceiling/False ceiling": {
    category: `False ceiling`,
    qty: {
      type: `ceiling`,
      led: true,
    },
    install: `Galvanised steel frame hung from the slab, gypsum boards screwed and jointed, then putty and paint. Plan electrical points first.`,
    care: `Dust light coves and fittings every few months.`,
  },
  "ceiling/Lighting": {
    category: `Lighting`,
    qty: {
      type: `count`,
      count: 1,
      unit: `fittings`,
    },
    install: `Installed by an electrician on a dedicated circuit; check ceiling fixing strength for heavy fittings.`,
    care: `Switch off and dust when cool; clean glass with a dry microfibre cloth.`,
  },
  "window/Curtains": {
    category: `Curtains`,
    qty: {
      type: `curtain`,
      fullness: 2.2,
      fabricWidth: 1.4,
    },
    install: `Mount the track 10 to 15 cm above the window (or at the ceiling) and 15 to 20 cm wider than the opening on each side.`,
    care: `Dry clean or gentle wash as per fabric; steam to release creases.`,
  },
  "window/Blinds and shutters": {
    category: `Window blinds`,
    qty: {
      type: `blind`,
    },
    install: `Measure inside the reveal at three points and order to the smallest width; fix brackets level.`,
    care: `Dust slats or fabric with a soft brush attachment.`,
  },
  "window/Frame": {
    category: `Window frame`,
    qty: {
      type: `count`,
      count: 1,
      unit: `window`,
    },
    install: `Supplied and fitted by a fabricator after site measurement of the opening.`,
    care: `Clean frames with mild soap; lubricate hinges yearly.`,
  },
  "door/Door style": {
    category: `Door`,
    qty: {
      type: `count`,
      count: 1,
      unit: `door`,
    },
    install: `Fit to the existing frame or replace the frame; allow for hinges, lock and stopper.`,
    care: `Wipe with a damp cloth; re-oil solid wood once a year.`,
  },
  "furniture/Upholstery": {
    category: `Upholstery fabric`,
    qty: {
      type: `upholstery`,
    },
    install: `Reupholstered by an upholsterer; check fabric rub count (25,000+ for daily use).`,
    care: `Vacuum weekly, rotate cushions, spot clean as per fabric code.`,
  },
  "furniture/Finish": {
    category: `Furniture finish`,
    qty: {
      type: `finish`,
    },
    install: `Refinished in a workshop or replaced fronts; confirm hardware positions before ordering.`,
    care: `Wipe with a soft damp cloth; avoid harsh chemicals.`,
  },
  "furniture/Edit": {
    category: `Edit`,
    qty: {
      type: `none`,
    },
    install: ``,
    care: ``,
  },
  "other/Edit": {
    category: `Edit`,
    qty: {
      type: `paint`,
      coverage: 11,
      coats: 2,
      primerCoverage: 12,
    },
    install: ``,
    care: ``,
  },
};
export const ITEM_QTY = {
  limewash: {
    type: `coating`,
    perM2: 0.25,
    unit: `L`,
    pack: 5,
  },
  venetian: {
    type: `coating`,
    perM2: 1.3,
    unit: `kg`,
    pack: 20,
  },
  araish: {
    type: `coating`,
    perM2: 6,
    unit: `kg`,
    pack: 25,
  },
  "microcement-wall": {
    type: `coating`,
    perM2: 1.6,
    unit: `kg`,
    pack: 20,
  },
  brick: {
    type: `pieces`,
    perM2: 48,
    wastage: 0.1,
    unit: `brick slips`,
    perBox: 50,
  },
  concrete: {
    type: `coating`,
    perM2: 2.5,
    unit: `kg`,
    pack: 25,
  },
  "walnut-slats": {
    type: `panel`,
    panelW: 0.6,
    panelH: 2.7,
    wastage: 0.1,
    unit: `panels`,
  },
  wainscoting: {
    type: `wainscot`,
  },
  "stacked-stone": {
    type: `boxes`,
    boxCoverage: 0.5,
    wastage: 0.1,
  },
  bookmatch: {
    type: `slabs`,
    slabW: 1.6,
    slabH: 2.8,
    wastage: 0.15,
  },
  "cane-panel": {
    type: `panel`,
    panelW: 0.6,
    panelH: 1.2,
    wastage: 0.1,
    unit: `panels`,
  },
  jaali: {
    type: `panel`,
    panelW: 1.22,
    panelH: 2.44,
    wastage: 0.1,
    unit: `sheets (8 x 4 ft)`,
  },
  "wp-grasscloth": {
    type: `wallpaper`,
    rollW: 0.91,
    rollL: 7.3,
    wastage: 0.15,
  },
  "tv-unit": {
    type: `count`,
    count: 1,
    unit: `unit`,
  },
  "gallery-wall": {
    type: `count`,
    count: 7,
    unit: `frames`,
  },
  "abstract-art": {
    type: `count`,
    count: 1,
    unit: `canvas`,
  },
  pichwai: {
    type: `count`,
    count: 1,
    unit: `painting`,
  },
  "round-mirror": {
    type: `count`,
    count: 1,
    unit: `mirror`,
  },
  shelves: {
    type: `count`,
    count: 3,
    unit: `shelves`,
  },
  sconces: {
    type: `count`,
    count: 2,
    unit: `sconces`,
  },
  herringbone: {
    type: `boxes`,
    boxCoverage: 1.3,
    wastage: 0.12,
    underlay: true,
  },
  chevron: {
    type: `boxes`,
    boxCoverage: 1.3,
    wastage: 0.12,
    underlay: true,
  },
  teak: {
    type: `boxes`,
    boxCoverage: 2,
    wastage: 0.08,
    underlay: true,
  },
  statuario: {
    type: `tiles`,
    tileW: 0.8,
    tileH: 1.6,
    perBox: 2,
    wastage: 0.12,
    adhesive: true,
  },
  kota: {
    type: `tiles`,
    tileW: 0.6,
    tileH: 0.6,
    perBox: 0,
    wastage: 0.08,
    adhesive: true,
  },
  terrazzo: {
    type: `area`,
  },
  athangudi: {
    type: `tiles`,
    tileW: 0.2,
    tileH: 0.2,
    perBox: 25,
    wastage: 0.1,
    adhesive: true,
  },
  porcelain: {
    type: `tiles`,
    tileW: 1.2,
    tileH: 0.6,
    perBox: 2,
    wastage: 0.1,
    adhesive: true,
  },
  checker: {
    type: `tiles`,
    tileW: 0.4,
    tileH: 0.4,
    perBox: 6,
    wastage: 0.12,
    adhesive: true,
  },
  moroccan: {
    type: `tiles`,
    tileW: 0.2,
    tileH: 0.2,
    perBox: 25,
    wastage: 0.1,
    adhesive: true,
  },
  slate: {
    type: `tiles`,
    tileW: 0.6,
    tileH: 0.4,
    perBox: 5,
    wastage: 0.1,
    adhesive: true,
  },
  "polished-concrete": {
    type: `area`,
  },
  epoxy: {
    type: `coating`,
    perM2: 1.5,
    unit: `kg`,
    pack: 10,
  },
  "ceiling-concrete": {
    type: `area`,
  },
  "ceiling-pine": {
    type: `boxes`,
    boxCoverage: 2,
    wastage: 0.1,
  },
  coffered: {
    type: `area`,
  },
  beams: {
    type: `beams`,
    spacing: 1,
  },
  battens: {
    type: `battens`,
    pitch: 0.1,
  },
  tray: {
    type: `ceiling`,
    led: false,
    downlightSpacing: 1.2,
  },
  floating: {
    type: `ceiling`,
    led: true,
    ledLabel: `LED profile`,
  },
  "rattan-pendants": {
    type: `count`,
    count: 3,
    unit: `pendants`,
  },
  "globe-pendants": {
    type: `count`,
    count: 4,
    unit: `pendants`,
  },
  chandelier: {
    type: `count`,
    count: 1,
    unit: `chandelier`,
  },
  downlights: {
    type: `grid`,
    spacing: 1.2,
    unit: `downlights`,
  },
  track: {
    type: `track`,
    spots: 4,
  },
  "steel-frame": {
    type: `count`,
    count: 1,
    unit: `window`,
  },
  remove: {
    type: `none`,
  },
  "other-remove": {
    type: `none`,
  },
};
