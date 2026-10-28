// Text sent to the models.

export const RENDER_SYSTEM_PROMPT = [
  "You are an architectural visualisation retoucher working for professional interior designers.",
  "You edit real photographs of rooms so a client can see a proposed material, finish or fixture in their own space.",
  "",
  "You always receive:",
  "- Image 1: the room photograph to edit.",
  "- Image 2: a black and white mask of the same size. White marks the target area. Black must stay unchanged.",
  "- Image 3 (when sent): the same photograph with the target area outlined in magenta and lightly tinted, so you can see exactly where to work. When the brief says so, the area inside also carries a perspective preview of the requested finish at partial opacity, showing how its lines must converge and how the room's light falls across it.",
  "- A text brief with the target surface, its coordinates and the requested design.",
  "",
  "Rules:",
  "1. Change only the target area. Outside it, keep everything identical: framing, camera angle, lens, furniture, decor, people, reflections and other surfaces.",
  "2. Respect the room geometry. New materials follow the plane of the surface and its perspective: floor planks and tiles recede to the same vanishing points as the room, wall panels stay vertical, ceiling features align with the ceiling edges.",
  "3. Match the existing light: direction, softness, colour temperature, window light falloff, ambient occlusion in corners and the contact shadows of anything standing on or against the surface.",
  "4. Respect occlusion. Objects in front of the target surface (furniture, plants, lamps, people) stay in front and are never painted over.",
  "5. Use realistic, correctly scaled materials: real tile and plank sizes, believable grout lines, real paint sheen. Keep skirting, switches, sockets, vents and trims unless the brief says otherwise.",
  "6. Never draw the mask, the magenta tint, outlines, highlights, labels, text or watermarks. Images 2 and 3 are guides only; the edit is made on Image 1.",
  "7. Return exactly one photorealistic image with the same framing and aspect ratio as Image 1. Do not crop, zoom, pan, rotate or add borders.",
  "8. Judge real-world scale from the room itself: a door is about 2.1 m tall, a ceiling 2.7 to 3.2 m high, a kitchen counter 0.9 m. Size tiles, planks, panels, grout lines and pattern repeats from those cues.",
  "9. Cover the whole target area right up to its edges, with crisp junctions at corners, skirting, ceiling lines and frames. No gaps, halos, smudges or leftover patches of the old finish.",
  "10. When the target is made of several separate parts, apply the same design consistently to every part, continuing patterns and lines across them.",
].join("\n");

export const MODE_TASKS = {
  surface:
    "Replace the finish of the target surface with the requested design. The surface keeps its exact shape, edges and position.",
  add: "Add the requested element on or within the target surface, sized realistically for the room. It may overlap neighbouring areas only where it physically must (a pendant cord, curtain fabric past the window frame, a rug edge under furniture legs).",
  restyle:
    "Keep the object in the same position, size and silhouette, and change only its material, upholstery or finish as requested.",
  remove:
    "Remove the object in the target area completely. Rebuild what would be behind it so the wall, floor, skirting, light and shadows continue naturally, with no ghosting.",
  custom: "Apply the designer notes to the target area.",
};

// The measured 3D facts about the target (lib/geometryFacts.js), as sentences. Empty when the room has not been analysed,
// when the surface has no fitted plane, or when it is several surfaces at once. Everything stated here was MEASURED from
// the photo's depth, so it is worded as a constraint, not a suggestion.
export function geometryLines(input) {
  const g = input.geometry;
  if (!g) {
    return [];
  }
  const lines = [];
  lines.push(
    "Measured 3D Surface Geometry (from a depth analysis of this photo; use it for scale and perspective): the target is " +
      g.widthM +
      " m wide by " +
      g.heightM +
      " m " +
      (g.orientation === "deep" ? "deep" : "tall") +
      "; its surface normal is (" +
      g.normal.join(", ") +
      ") in camera space (x right, y down, z forward) and it is about " +
      g.distanceM +
      " m from the camera. The camera's horizontal field of view is " +
      g.fovDeg +
      " degrees.",
  );
  const texture = input.item && input.item.texture;
  if (texture && texture.tileWidthM && texture.tileHeightM) {
    lines.push(
      "Tile repeat scale must match " +
        texture.tileWidthM +
        " m x " +
        texture.tileHeightM +
        " m, with perspective foreshortening matching camera focal length " +
        g.focalPxImage +
        " px (in Image 1's pixels): the repeat shrinks with distance exactly as the room's own lines do.",
    );
  } else {
    lines.push(
      "Size the pattern, joints and details from these real dimensions, with perspective foreshortening matching camera focal length " +
        g.focalPxImage +
        " px (in Image 1's pixels).",
    );
  }
  if (g.previewShown) {
    lines.push(
      "Inside the outline, Image 3 carries a perspective-correct preview of this finish at 35% opacity: keep its line convergence, repeat scale and the way the room's light and shadows fall across it. It is a guide for geometry and lighting only; do not copy its colours or its edges.",
    );
  }
  return lines;
}

// The brief sent with the images for one render.
export function renderBrief(input) {
  const lines = [];
  lines.push(
    "Image 1 is " +
      input.width +
      " x " +
      input.height +
      " px" +
      (input.crop ? ", a close crop of the room centred on the target" : "") +
      ". Image 2 is its mask (white = target)." +
      (input.guide
        ? " Image 3 is Image 1 with the target tinted magenta and outlined, for orientation only."
        : ""),
  );
  lines.push("");
  lines.push(
    'Target surface: "' +
      input.label +
      '" (type: ' +
      input.kind +
      ")." +
      (input.partCount > 1
        ? " It is made of " + input.partCount + " separate parts."
        : ""),
  );
  const box = input.box;
  lines.push(
    "Bounding box [ymin, xmin, ymax, xmax], normalised 0-1000: [" +
      box.ymin +
      ", " +
      box.xmin +
      ", " +
      box.ymax +
      ", " +
      box.xmax +
      "].",
  );
  lines.push(
    "Bounding box in Image 1 pixels: x " +
      Math.round((box.xmin / 1000) * input.width) +
      " to " +
      Math.round((box.xmax / 1000) * input.width) +
      ", y " +
      Math.round((box.ymin / 1000) * input.height) +
      " to " +
      Math.round((box.ymax / 1000) * input.height) +
      ".",
  );
  if (input.polygon && input.polygon.length >= 3) {
    const points = input.polygon
      .map(function (point) {
        return "[" + point[0] + ", " + point[1] + "]";
      })
      .join(", ");
    lines.push(
      "Outline polygon as [x, y] points, normalised 0-1000, origin top-left: " +
        points +
        ".",
    );
  }
  lines.push(
    "The target covers about " +
      (input.areaShare * 100).toFixed(1) +
      "% of the photo; its centre is near x " +
      Math.round(input.centerX) +
      ", y " +
      Math.round(input.centerY) +
      " (0-1000).",
  );
  const geometryText = geometryLines(input);
  if (geometryText.length > 0) {
    lines.push("");
    geometryText.forEach(function (line) {
      lines.push(line);
    });
  }
  lines.push("");
  const mode = input.item ? input.item.mode : "custom";
  lines.push("Task: " + MODE_TASKS[mode]);
  if (input.item) {
    lines.push(
      "Design: " +
        input.item.name +
        (input.item.sub ? " (" + input.item.sub + ")" : "") +
        ".",
    );
    lines.push("Details: " + input.item.prompt);
  }
  if (input.style) {
    lines.push(
      "Overall style direction for the room: " +
        input.style +
        ". Use it to guide undertones, proportions and detailing.",
    );
  }
  if (input.notes && input.notes.trim() !== "") {
    lines.push("Designer notes (follow these closely): " + input.notes.trim());
  }
  lines.push("");
  lines.push(
    "Keep everything outside the white mask area exactly as it is in Image 1, and return the full frame of Image 1 at the same aspect ratio.",
  );
  return lines.join("\n");
}

export const MEASURE_SCHEMA = {
  type: "OBJECT",
  properties: {
    area_m2: { type: "NUMBER" },
    visible_area_m2: { type: "NUMBER" },
    width_m: { type: "NUMBER" },
    height_m: { type: "NUMBER" },
    depth_m: { type: "NUMBER" },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
    basis: { type: "STRING" },
    rendered_description: { type: "STRING" },
  },
  required: ["area_m2", "confidence", "basis", "rendered_description"],
};

export function measurePrompt(input) {
  return [
    "You help an interior designer prepare a material take-off from a room photograph.",
    "Image 1 is the room after a proposed change. Image 2 is a mask: white is the target surface.",
    'Target surface: "' + input.regionLabel + '" (type: ' + input.kind + ").",
    "Product applied: " +
      input.productName +
      (input.productSub ? " (" + input.productSub + ")" : "") +
      ".",
    "",
    "Estimate in metres, using scale cues: standard internal doors are about 2.1 m tall and 0.8 to 0.9 m wide,",
    "ceilings in Indian apartments are usually 2.7 to 3.0 m, switch boards sit about 1.2 m above the floor,",
    "floor tiles are often 600 mm, sofa seats are about 0.45 m high, kitchen counters about 0.9 m high.",
    "",
    "Return JSON with:",
    "- area_m2: the full area that would receive this product. For a floor or ceiling, the whole room area as far as can be inferred, including parts hidden behind furniture. For a wall, the full wall plane minus doors and windows; for several walls, their total. For a window or door, the opening. For furniture, its outer surface to be covered.",
    "- visible_area_m2: the area visible in the photo.",
    "- width_m and height_m: overall size of the surface or object (floor and ceiling: width across the photo, and use depth_m for the depth into the room; window: opening width and height; sofa: overall width and height).",
    "- confidence: low, medium or high.",
    "- basis: one short sentence naming the scale cue you used.",
    "- rendered_description: one or two sentences describing the new product exactly as it appears in Image 1 (pattern, colour, finish, scale). Do not mention masks or images.",
  ].join("\n");
}
