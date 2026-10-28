// First screen, shown only when the server asks for a studio passcode (STUDIO_PASSCODE).
import { cx, h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { spinner } from "./ui.js";
import { swatchMarkup } from "./swatch.js";

const FAN = [
  {
    seed: "fan-limewash",
    spec: { type: "plaster", base: "#D9CDBB", variant: "limewash" },
  },
  {
    seed: "fan-herring",
    spec: {
      type: "wood",
      base: "#B88B5C",
      dark: "#94693F",
      pattern: "herringbone",
    },
  },
  {
    seed: "fan-athangudi",
    spec: {
      type: "tile",
      pattern: "athangudi",
      colors: ["#C9B48A", "#8E2F2B", "#1F4A4C"],
    },
  },
  { seed: "fan-sage", spec: { type: "paint", hex: "#A7B297" } },
  {
    seed: "fan-marble",
    spec: {
      type: "stone",
      base: "#F1EFEB",
      vein: "#8C8986",
      variant: "marble",
    },
  },
];

// props: passcode, error, busy, onPasscode, onSubmit, serverProblem
export function gateView(props) {
  return h(
    "main",
    { class: "sr-gate" },
    h(
      "section",
      { class: "sr-gate-intro" },
      h("p", { class: "sr-gate-kicker" }, "Terucon Design Studio"),
      h(
        "h1",
        { class: "sr-wordmark sr-wordmark-large" },
        "Swatch",
        h("em", null, "room"),
      ),
      h(
        "p",
        { class: "sr-gate-lede" },
        "Photograph a room, tap a wall, floor or ceiling, and see a new finish rendered into the real space.",
      ),
      h(
        "div",
        { class: "sr-fan", "aria-hidden": "true" },
        FAN.map(function (strip, index) {
          return h(
            "div",
            {
              key: strip.seed,
              class: "sr-fan-strip",
              style: { "--fan-index": index },
            },
            h("span", {
              class: "sr-fan-swatch",
              html: swatchMarkup(strip.spec, strip.seed, "fan"),
            }),
          );
        }),
        h("span", { class: "sr-fan-rivet" }),
      ),
    ),
    h(
      "ol",
      { class: "sr-gate-steps" },
      h("li", null, "Enter the studio passcode your team shared with you."),
      h(
        "li",
        null,
        "Add a room photo. The studio maps its walls, floor, ceiling, windows and furniture.",
      ),
      h(
        "li",
        null,
        "Tap a surface, pick a finish, and render it into the photo. Rooms are saved on the server, so they open on any device.",
      ),
    ),
    h(
      "section",
      { class: "sr-gate-panel", "aria-labelledby": "sr-gate-title" },
      h(
        "h2",
        { id: "sr-gate-title", class: "sr-gate-title" },
        "Sign in to the studio",
      ),
      h(
        "p",
        { class: "sr-gate-help" },
        "This studio is for the Terucon team. This browser only needs the passcode.",
      ),
      h(
        "form",
        {
          class: "sr-key-card",
          onsubmit: function (event) {
            event.preventDefault();
            props.onSubmit();
          },
        },
        h(
          "div",
          { class: "sr-key-card-head" },
          icon("lock-keyhole", 18),
          h("span", { class: "sr-key-card-title" }, "Studio passcode"),
        ),
        h(
          "label",
          { class: "sr-visually-hidden", htmlFor: "sr-passcode" },
          "Studio passcode",
        ),
        h("input", {
          id: "sr-passcode",
          class: "sr-input",
          type: "password",
          autocomplete: "current-password",
          value: props.passcode,
          placeholder: "Passcode",
          oninput: function (event) {
            props.onPasscode(event.target.value);
          },
        }),
        h(
          "button",
          {
            type: "submit",
            class: "sr-button sr-button-primary sr-button-wide",
            disabled: props.busy || props.passcode.trim() === "",
          },
          props.busy ? spinner() : null,
          props.busy ? "Checking…" : "Open the studio",
          !props.busy ? icon("chevron-right", 18) : null,
        ),
      ),
      props.error
        ? h("p", { class: cx("sr-form-error"), role: "alert" }, props.error)
        : null,
      props.serverProblem
        ? h("p", { class: "sr-form-error", role: "alert" }, props.serverProblem)
        : null,
    ),
  );
}
