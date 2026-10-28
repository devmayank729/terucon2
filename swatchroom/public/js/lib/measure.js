// After a render, ask Gemini to estimate the real size of the surface for the take-off.

import { generate, parseJsonText, readResponse } from "./ai.js";
import { MEASURE_SCHEMA, measurePrompt } from "./prompts.js";

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export async function measureSurface(input) {
  const contents = [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: input.imageBase64 } },
        { inlineData: { mimeType: "image/png", data: input.maskBase64 } },
        { text: measurePrompt(input) },
      ],
    },
  ];
  const answer = await generate(
    {
      task: "json",
      model: input.model,
      location: input.location,
      contents: contents,
      schema: MEASURE_SCHEMA,
      maxTokens: 2048,
    },
    input.signal,
  );
  const parsed = parseJsonText(readResponse(answer.response).texts.join("\n"));
  const confidence =
    ["low", "medium", "high"].indexOf(parsed.confidence) === -1
      ? "low"
      : parsed.confidence;
  return {
    areaM2: positive(parsed.area_m2),
    visibleAreaM2: positive(parsed.visible_area_m2),
    widthM: positive(parsed.width_m),
    heightM: positive(parsed.height_m),
    depthM: positive(parsed.depth_m),
    confidence: confidence,
    basis: String(parsed.basis || "").slice(0, 300),
    renderedDescription: String(parsed.rendered_description || "").slice(
      0,
      600,
    ),
  };
}
