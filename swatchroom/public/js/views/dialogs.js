// Dialogs: settings, request inspector, keyboard shortcuts, product sheet, materials list,
// share and export, and the phone versions sheet.
//
// Each dialog is a function of (props, ui, setUi): props come from the studio, ui holds the
// dialog's own small state (which tab is open, text being typed) and setUi changes it.
import { cx, h } from "../core/dom.js";
import { publicText } from "../core/modelLog.js";
import { icon } from "../core/icons.js";
import { modal, spinner } from "./ui.js";
import { swatchMarkup } from "./swatch.js";
import { versionsStrip } from "./versions.js";
import {
  IMAGE_MODELS,
  LOCATIONS,
  RENDER_ENGINES,
  SCENE_MODELS,
  defaultSettings,
} from "../lib/settings.js";
import {
  MODE_LABELS,
  NEEDS_WIDTH,
  formatArea,
  m2FromSqft,
  productAmount,
  productName,
  productSize,
  productSpec,
  sqftFromM2,
  takeoff,
  unitSingular,
} from "../lib/products.js";

export function copyText(text, done) {
  try {
    navigator.clipboard.writeText(text).then(done, function () {});
  } catch (error) {
    // clipboard unavailable
  }
}

function swatchOrChip(item, place, className) {
  if (item) {
    return h("span", {
      class: className,
      html: swatchMarkup(item.swatch, item.id, place),
    });
  }
  return h(
    "span",
    { class: className },
    h("span", { class: "sr-custom-chip" }),
  );
}

function radioRow(options) {
  return h(
    "label",
    {
      key: options.key || options.title,
      class: cx("sr-radio-row", options.disabled && "is-disabled"),
    },
    h("input", {
      type: "radio",
      name: options.name,
      checked: !!options.checked,
      disabled: !!options.disabled,
      onchange: options.onChange,
    }),
    h(
      "span",
      null,
      h("strong", null, options.title),
      h("span", { class: "sr-radio-sub" }, options.text),
    ),
  );
}

function checkbox(checked, onChange, text) {
  return h(
    "label",
    { class: "sr-checkbox" },
    h("input", {
      type: "checkbox",
      checked: !!checked,
      onchange: function (event) {
        onChange(event.target.checked);
      },
    }),
    h("span", null, text),
  );
}

function field(id, label) {
  return h("label", { class: "sr-field-label", htmlFor: id }, label);
}

function select(id, value, options, onChange) {
  return h(
    "select",
    {
      id: id,
      class: "sr-input sr-input-compact",
      value: String(value),
      onchange: function (event) {
        onChange(event.target.value);
      },
    },
    options.map(function (option) {
      return h(
        "option",
        { key: String(option[0]), value: String(option[0]) },
        option[1],
      );
    }),
  );
}

function textInput(id, value, onChange, extra) {
  return h(
    "input",
    Object.assign(
      {
        id: id,
        class: "sr-input sr-input-compact",
        value: value,
        oninput: function (event) {
          onChange(event.target.value);
        },
      },
      extra || {},
    ),
  );
}

const SETTINGS_TABS = [
  ["detection", "Detection"],
  ["render", "Render"],
  ["products", "Materials"],
  ["check", "Check"],
];

const STATUS_ICONS = {
  ok: "circle-check",
  warn: "triangle-alert",
  error: "circle-alert",
};

// The three room-pipeline models (server/lib/pipelineRunner.js), named exactly as the Check
// tab names them, so a designer sees the same three names everywhere this feature shows up.
const PIPELINE_MODELS = [
  ["sam3", "Surface check", "Scores the scan's own wall, floor and ceiling regions"],
  ["moge2", "3D shape", "The room's 3D shape, in real metres"],
  ["marigold", "Colour and light", "Splits the photo into colour and light"],
];

const PROGRESS_LABELS = {
  sam3: "surface check",
  moge2: "3D shape",
  marigold: "colour and light",
  fusion: "combining",
};

// Turns studio.js's this.ui.fusion ({status, progress, error} | null) for the open room into
// one plain sentence.
function fusionLine(status) {
  if (!status) {
    return "Scan this room to start it.";
  }
  if (status.status === "checking") {
    return "Checking what this room already has…";
  }
  if (status.status === "running") {
    const progress = status.progress || {};
    const parts = ["sam3", "moge2", "marigold", "fusion"]
      .filter(function (key) {
        return !!progress[key];
      })
      .map(function (key) {
        return PROGRESS_LABELS[key] + ": " + progress[key];
      });
    return "Running" + (parts.length ? " (" + parts.join(", ") + ")" : "") + "…";
  }
  if (status.status === "ready") {
    return "Ready - finishes on this photo can preview instantly.";
  }
  if (status.status === "error") {
    return "Could not finish: " + (status.error || "unknown error") + ".";
  }
  return "Idle.";
}

// props: open, settings, onChange, onClose, server (session info), errorLog, onToast,
//        onCheck (async, resolves to results), onForgetModels, onSignOut
export function settingsDialog(props, ui, setUi) {
  const settings = props.settings;
  const server = props.server || {};
  const pipeline = server.pipeline || {};
  const fusionStatus = props.fusionStatus || null;
  const fastRendererKind = props.fastRendererKind || null;
  const tab = ui.tab || "detection";
  function set(fieldName, value) {
    const next = Object.assign({}, settings);
    next[fieldName] = value;
    props.onChange(next);
  }
  let body = null;

  if (tab === "detection") {
    body = h(
      "div",
      { class: "sr-settings-grid" },
      h(
        "fieldset",
        { class: "sr-settings-section" },
        h("legend", null, "How surfaces are found"),
        h(
          "div",
          { class: "sr-radio-list" },
          radioRow({
            name: "engine",
            title: "Precise, on the server (recommended)",
            text: "Scene parsing (150 indoor classes) in the model service, snapped to the photo's edges. AI splits walls into planes and names surfaces.",
            checked: settings.segmentationEngine === "scene",
            onChange: function () {
              set("segmentationEngine", "scene");
            },
          }),
          radioRow({
            name: "engine",
            title: "AI only",
            text: "AI outlines only. No model service needed; coarser edges.",
            checked: settings.segmentationEngine === "gemini",
            onChange: function () {
              set("segmentationEngine", "gemini");
            },
          }),
        ),
        checkbox(
          settings.useGeminiAssist,
          function (value) {
            set("useGeminiAssist", value);
          },
          "Use AI to split walls into planes and give surfaces descriptive names",
        ),
        checkbox(
          settings.useHdScan !== false,
          function (value) {
            set("useHdScan", value);
          },
          "Also scan with the HD engine (OneFormer) when the server has one, and offer its sharper result when it arrives",
        ),
        checkbox(
          settings.samCalibrate !== false,
          function (value) {
            set("samCalibrate", value);
          },
          "When I select a surface, sharpen its edges with SAM and cut out rugs, furniture and pictures standing on it",
        ),
        checkbox(
          settings.fallbackToGemini,
          function (value) {
            set("fallbackToGemini", value);
          },
          "If the chosen engine fails, fall back to AI outlines",
        ),
        checkbox(
          settings.hideSmallSurfaces,
          function (value) {
            set("hideSmallSurfaces", value);
          },
          'Tuck small furniture and decor into "Small items" in the list',
        ),
      ),
      h(
        "fieldset",
        { class: "sr-settings-section" },
        h("legend", null, "Scene model (model service)"),
        h(
          "div",
          { class: "sr-radio-list" },
          SCENE_MODELS.map(function (model) {
            return radioRow({
              key: model.id,
              name: "scene-model",
              title: model.name,
              text: model.note,
              checked: settings.sceneModel === model.id,
              onChange: function () {
                set("sceneModel", model.id);
              },
            });
          }),
        ),
        h(
          "div",
          { class: "sr-settings-pair" },
          field("sr-analysis-size", "Detection resolution"),
          select(
            "sr-analysis-size",
            settings.analysisMaxSide,
            [
              [768, "768 px, faster"],
              [1024, "1024 px"],
              [1280, "1280 px, finer edges"],
            ],
            function (value) {
              set("analysisMaxSide", Number(value));
            },
          ),
          field("sr-ai-engine", "AI-only engine"),
          select(
            "sr-ai-engine",
            settings.geminiEngine,
            [
              ["polygon", "Outlines (recommended)"],
              ["auto", "Pixel masks, then outlines"],
              [
                "mask",
                "Pixel masks only (retired 20 Oct 2026)",
              ],
            ],
            function (value) {
              set("geminiEngine", value);
            },
          ),
        ),
      ),
    );
  }

  if (tab === "render") {
    body = h(
      "div",
      { class: "sr-settings-grid" },
      h(
        "fieldset",
        { class: "sr-settings-section" },
        h("legend", null, "How finishes render"),
        h(
          "div",
          { class: "sr-radio-list" },
          RENDER_ENGINES.map(function (engineOption) {
            return radioRow({
              key: engineOption.id,
              name: "render-engine",
              title: engineOption.name,
              text: engineOption.note,
              checked: (settings.renderEngine || "auto") === engineOption.id,
              onChange: function () {
                set("renderEngine", engineOption.id);
              },
            });
          }),
        ),
      ),
      h(
        "fieldset",
        { class: "sr-settings-section" },
        h("legend", null, "Room pipeline (instant preview)"),
        h(
          "p",
          { class: "sr-settings-text" },
          "Three room models work out each room's real 3D shape and lighting once per photo, so a finish can preview instantly here instead of always waiting on an AI render. Low-confidence surfaces, and every saved render, still use AI.",
        ),
        h(
          "ul",
          { class: "sr-check-list" },
          PIPELINE_MODELS.map(function (row) {
            const key = row[0];
            const configured = !!pipeline[key];
            return h(
              "li",
              {
                key: key,
                class: "sr-check sr-check-" + (configured ? "ok" : "warn"),
              },
              icon(STATUS_ICONS[configured ? "ok" : "warn"], 18),
              h(
                "span",
                null,
                h("strong", null, row[1]),
                configured
                  ? row[2] + "."
                  : "Not set up on the server yet.",
              ),
            );
          }),
        ),
        h(
          "p",
          { class: "sr-settings-text" },
          "This room: " + fusionLine(fusionStatus),
        ),
        h(
          "p",
          { class: "sr-settings-text" },
          fastRendererKind
            ? "Instant preview backend in this browser: " + fastRendererKind.toUpperCase() + "."
            : "No instant preview is active in this browser yet - either none has been needed so far, or it has neither WebGPU nor WebGL2, in which case finishes here always render with AI.",
        ),
        h(
          "p",
          { class: "sr-settings-text" },
          "Open the Check tab for a live connection test against each model's own server.",
        ),
      ),
      h(
        "fieldset",
        { class: "sr-settings-section" },
        h("legend", null, "Render model"),
        h(
          "div",
          { class: "sr-radio-list" },
          IMAGE_MODELS.map(function (model) {
            return radioRow({
              key: model.id,
              name: "image-model",
              title: model.name,
              text: model.note + ".",
              checked: settings.imageModel === model.id,
              onChange: function () {
                set("imageModel", model.id);
              },
            });
          }),
        ),
      ),
      h(
        "fieldset",
        { class: "sr-settings-section" },
        h("legend", null, "Quality and requests"),
        h(
          "div",
          { class: "sr-settings-pair" },
          field("sr-render-size", "Render resolution"),
          select(
            "sr-render-size",
            settings.renderSize,
            [
              ["2K", "2K (recommended)"],
              ["4K", "4K, sharper, slower and costs more"],
            ],
            function (value) {
              set("renderSize", value);
            },
          ),
          field("sr-location", "AI region"),
          select(
            "sr-location",
            settings.location,
            LOCATIONS.map(function (location) {
              return [
                location,
                location === "global" ? "global (recommended)" : location,
              ];
            }),
            function (value) {
              set("location", value);
            },
          ),
          field("sr-upload-size", "Photo size sent for renders"),
          select(
            "sr-upload-size",
            settings.uploadMaxSide,
            [
              [1280, "1280 px long side"],
              [1600, "1600 px long side"],
              [2048, "2048 px long side"],
            ],
            function (value) {
              set("uploadMaxSide", Number(value));
            },
          ),
        ),
        checkbox(
          settings.sendPolygon,
          function (value) {
            set("sendPolygon", value);
          },
          "Send the traced outline polygon with each render, alongside the box and mask",
        ),
        h(
          "div",
          { class: "sr-row-actions" },
          h(
            "button",
            {
              type: "button",
              class: "sr-button sr-button-quiet",
              onclick: props.onForgetModels,
            },
            icon("rotate-ccw", 15),
            " Retry newest models",
          ),
        ),
      ),
    );
  }

  if (tab === "products") {
    body = h(
      "div",
      { class: "sr-settings-grid" },
      h(
        "fieldset",
        { class: "sr-settings-section" },
        h("legend", null, "Quantities"),
        checkbox(
          settings.estimateQuantities,
          function (value) {
            set("estimateQuantities", value);
          },
          "After each render, ask AI to measure the surface for the quantity take-off",
        ),
        h(
          "div",
          { class: "sr-settings-pair" },
          field("sr-area-unit", "Show areas in"),
          select(
            "sr-area-unit",
            settings.areaUnit,
            [
              ["sqft", "Square feet first"],
              ["m2", "Square metres first"],
            ],
            function (value) {
              set("areaUnit", value);
            },
          ),
          field("sr-currency", "Currency symbol"),
          textInput(
            "sr-currency",
            settings.currency,
            function (value) {
              set("currency", value);
            },
            { maxlength: "4" },
          ),
        ),
      ),
      h(
        "fieldset",
        { class: "sr-settings-section" },
        h("legend", null, "Server and saved rooms"),
        h(
          "p",
          { class: "sr-settings-text" },
          server.google && server.google.configured
            ? "AI is connected. Rooms are saved on the server, so they open on any device that can reach it."
            : "AI is not set up on the server yet, so AI rendering is off.",
        ),
        h(
          "div",
          { class: "sr-row-actions" },
          server.passcodeRequired
            ? h(
                "button",
                {
                  type: "button",
                  class: "sr-button sr-button-quiet",
                  onclick: props.onSignOut,
                },
                icon("log-out", 15),
                " Sign out of the studio",
              )
            : null,
          h(
            "button",
            {
              type: "button",
              class: "sr-button sr-button-quiet",
              onclick: function () {
                props.onChange(defaultSettings());
              },
            },
            "Restore default settings",
          ),
        ),
      ),
    );
  }

  if (tab === "check") {
    const checks = ui.checks;
    body = h(
      "div",
      { class: "sr-diagnostics" },
      h(
        "div",
        { class: "sr-row-actions" },
        h(
          "button",
          {
            type: "button",
            class: "sr-button sr-button-primary",
            disabled: !!ui.checking,
            onclick: props.onCheck,
          },
          ui.checking ? spinner() : null,
          ui.checking ? "Checking…" : "Check everything",
        ),
      ),
      checks
        ? h(
            "ul",
            { class: "sr-check-list" },
            checks.map(function (entry) {
              return h(
                "li",
                { key: entry.name, class: "sr-check sr-check-" + entry.status },
                icon(STATUS_ICONS[entry.status] || "info", 18),
                h(
                  "span",
                  null,
                  h("strong", null, entry.name),
                  h("span", { class: "sr-check-detail" }, entry.detail),
                ),
              );
            }),
          )
        : null,
      h("h3", { class: "sr-sheet-heading" }, "Recent errors"),
      props.errorLog.length === 0
        ? h("p", { class: "sr-settings-text" }, "No errors in this session.")
        : [
            h(
              "ul",
              { class: "sr-error-log" },
              props.errorLog
                .slice()
                .reverse()
                .map(function (entry, index) {
                  return h(
                    "li",
                    { key: "error-" + (props.errorLog.length - index) },
                    h(
                      "span",
                      { class: "sr-error-meta" },
                      entry.time +
                        " " +
                        entry.context +
                        (entry.status ? ", HTTP " + entry.status : ""),
                    ),
                    h("span", null, entry.message),
                    entry.apiMessage && entry.apiMessage !== entry.message
                      ? h("span", { class: "sr-error-api" }, publicText(entry.apiMessage))
                      : null,
                  );
                }),
            ),
            h(
              "div",
              { class: "sr-row-actions" },
              h(
                "button",
                {
                  type: "button",
                  class: "sr-button sr-button-quiet",
                  onclick: function () {
                    copyText(
                      JSON.stringify(props.errorLog, null, 2),
                      function () {
                        setUi({ copied: true });
                        setTimeout(function () {
                          setUi({ copied: false });
                        }, 1600);
                      },
                    );
                  },
                },
                icon("copy", 15),
                ui.copied ? " Copied" : " Copy log to share",
              ),
            ),
          ],
    );
  }

  return modal({
    key: "settings",
    open: props.open,
    onClose: props.onClose,
    title: "Settings",
    titleId: "sr-settings-title",
    size: "wide",
    body: [
      h(
        "div",
        {
          class: "sr-tabs",
          role: "tablist",
          "aria-label": "Settings sections",
        },
        SETTINGS_TABS.map(function (entry) {
          return h(
            "button",
            {
              key: entry[0],
              type: "button",
              role: "tab",
              "aria-selected": tab === entry[0] ? "true" : "false",
              class: cx("sr-tab", tab === entry[0] && "is-active"),
              onclick: function () {
                setUi({ tab: entry[0] });
              },
            },
            entry[1],
          );
        }),
      ),
      body,
    ],
  });
}

// props: version (or null), onClose
export function inspectorDialog(props, ui, setUi) {
  const version = props.version;
  const request = version ? version.request : null;
  const facts = request
    ? [
        ["Engine", "AI render"],
        ["Surface", request.regionLabel + ", treated as " + request.regionKind],
        ["Finish", request.itemName || "Notes only"],
        ["Based on", request.basedOn],
        [
          "Sizes",
          "base " +
            request.inputSize +
            ", returned " +
            request.outputSize +
            ", aspect " +
            request.aspectRatio +
            (request.imageSize ? ", asked for " + request.imageSize : ""),
        ],
        [
          "Time",
          (request.durationMs / 1000).toFixed(1) +
            " s" +
            (request.attempt > 0
              ? ", simplified request used (attempt " +
                (request.attempt + 1) +
                ")"
              : ""),
        ],
      ]
    : [];
  if (request && request.usage && request.usage.totalTokenCount) {
    facts.push([
      "Tokens",
      request.usage.promptTokenCount +
        " in, " +
        (request.usage.candidatesTokenCount || 0) +
        " out",
    ]);
  }
  function copy() {
    const summary = {
      model: request.model,
      location: request.location,
      systemInstruction: request.systemPrompt,
      contents: [
        "<image 1: room photo, image/jpeg>",
        "<image 2: region mask, image/png>",
        "<image 3: guide, image/jpeg (not sent to Lite models)>",
        request.prompt,
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: request.aspectRatio,
          imageSize: request.imageSize || undefined,
        },
      },
    };
    copyText(JSON.stringify(summary, null, 2), function () {
      setUi({ copied: true });
      setTimeout(function () {
        setUi({ copied: false });
      }, 1800);
    });
  }
  return modal({
    key: "inspector",
    open: !!request,
    onClose: props.onClose,
    title: version ? "Request for v" + version.number : "Request",
    titleId: "sr-inspector-title",
    size: "wide",
    body: request
      ? h(
          "div",
          { class: "sr-inspector" },
          h(
            "dl",
            { class: "sr-facts" },
            facts.map(function (entry) {
              return h(
                "div",
                { key: entry[0] },
                h("dt", null, entry[0]),
                h("dd", null, entry[1]),
              );
            }),
          ),
          h(
            "h3",
            { class: "sr-sheet-heading" },
            "Brief sent with the photo and mask",
          ),
          h("pre", { class: "sr-pre" }, request.prompt),
          h("h3", { class: "sr-sheet-heading" }, "System instruction"),
          h("pre", { class: "sr-pre" }, request.systemPrompt),
          request.modelText
            ? [
                h(
                  "h3",
                  { class: "sr-sheet-heading" },
                  "Text the model returned",
                ),
                h("pre", { class: "sr-pre" }, request.modelText),
              ]
            : null,
          h(
            "div",
            { class: "sr-row-actions" },
            h(
              "button",
              {
                type: "button",
                class: "sr-button sr-button-quiet",
                onclick: copy,
              },
              icon("copy", 15),
              ui.copied ? " Copied" : " Copy request as JSON",
            ),
          ),
        )
      : null,
  });
}

const SHORTCUTS = [
  ["Click", "Select the surface under the cursor"],
  ["Shift + click", "Add or remove a surface from the selection"],
  ["A", "Select every surface of the selected kind"],
  ["Ctrl + Enter", "Render the selected finish"],
  ["/", "Search finishes"],
  ["V", "Select tool"],
  ["W", "Pick: cut out anything by clicking it"],
  ["B", "Brush: add or erase pixels on the selected surface"],
  ["L", "Outline a surface by hand"],
  ["Ctrl + Z, Ctrl + Shift + Z", "Undo and redo surface edits"],
  ["Scroll, + and -", "Zoom; 0 or F fits the photo"],
  ["Space + drag", "Pan when zoomed"],
  ["M", "Show or hide the surface map"],
  ["C", "Compare with the version it was made from"],
  ["P", "Materials and quantities in this version"],
  ["[ and ]", "Previous or next version"],
  ["Esc", "Back to Select, leave compare, then clear the selection"],
];

export function shortcutsDialog(props) {
  return modal({
    key: "shortcuts",
    open: props.open,
    onClose: props.onClose,
    title: "Keyboard shortcuts",
    titleId: "sr-shortcuts-title",
    size: "small",
    body: [
      h(
        "dl",
        { class: "sr-shortcuts" },
        SHORTCUTS.map(function (entry) {
          return h(
            "div",
            { key: entry[0], class: "sr-shortcut" },
            h("dt", null, h("kbd", null, entry[0])),
            h("dd", null, entry[1]),
          );
        }),
      ),
      h(
        "p",
        { class: "sr-settings-text" },
        "On a phone or tablet: tap to select; hold or drag to aim with the magnifier and lift to select; hold still a little longer to add a surface; pinch to zoom, double-tap to zoom in or out.",
      ),
    ],
  });
}

// The text boxes of the product sheet start from the product's current numbers, and are
// refilled when another product opens or its estimate arrives.
export function productFormFor(product, unit) {
  const size = productSize(product);
  return {
    key: product.id + "|" + product.status + "|" + unit,
    area:
      size.areaM2 > 0
        ? String(
            Math.round(
              (unit === "m2" ? size.areaM2 : sqftFromM2(size.areaM2)) * 10,
            ) / 10,
          )
        : "",
    width: size.widthM > 0 ? String(Math.round(size.widthM * 100) / 100) : "",
    rate: product.rate > 0 ? String(product.rate) : "",
  };
}

// props: product (or null), onClose, onChange(id, changes), areaUnit, currency
export function productDialog(props, ui, setUi) {
  const product = props.product;
  const unit = props.areaUnit || "sqft";
  if (!product) {
    return modal({
      key: "product",
      open: false,
      onClose: props.onClose,
      title: "",
      titleId: "sr-product-title",
    });
  }
  let form = ui.form;
  if (!form || form.key !== product.id + "|" + product.status + "|" + unit) {
    form = productFormFor(product, unit);
    ui.form = form;
  }
  const size = productSize(product);
  const spec = productSpec(product.item);
  const result = takeoff(product.item, size);
  const overridden =
    product.override &&
    (product.override.areaM2 > 0 || product.override.widthM > 0);
  const amount = productAmount(product);
  const measure = product.measure || {};
  let basis = "";
  if (product.status === "estimating") {
    basis = "Estimating the size from the photo…";
  } else if (product.status === "failed") {
    basis =
      "The size could not be estimated (" +
      (product.error || "no answer") +
      "). Enter the area to calculate.";
  } else if (overridden) {
    basis = "Using your measurement.";
  } else if (measure.areaM2 > 0) {
    basis =
      "Estimated from the photo, " +
      measure.confidence +
      " confidence. " +
      (measure.basis || "");
  }
  function setForm(changes) {
    setUi({ form: Object.assign({}, form, changes) });
  }
  function changeArea(value) {
    setForm({ area: value });
    const number = Number(value);
    const areaM2 =
      number > 0 ? (unit === "m2" ? number : m2FromSqft(number)) : 0;
    props.onChange(product.id, {
      override: Object.assign({}, product.override, { areaM2: areaM2 }),
    });
  }
  function changeWidth(value) {
    setForm({ width: value });
    const number = Number(value);
    props.onChange(product.id, {
      override: Object.assign({}, product.override, {
        widthM: number > 0 ? number : 0,
      }),
    });
  }
  function changeRate(value) {
    setForm({ rate: value });
    const number = Number(value);
    props.onChange(product.id, { rate: number > 0 ? number : 0 });
  }
  function copySpec() {
    const lines = [
      productName(product) + " (" + spec.category + ")",
      "Surface: " + product.regionLabel,
      product.item ? "Spec: " + product.item.sub : "",
      product.item ? product.item.about : product.notes,
      size.areaM2 > 0 ? "Area: " + formatArea(size.areaM2, unit) : "",
    ]
      .concat(
        result.lines.map(function (line) {
          return line[0] + ": " + line[1];
        }),
        [
          amount
            ? "Amount: " + props.currency + amount.toLocaleString("en-IN")
            : "",
          spec.install ? "Install: " + spec.install : "",
        ],
      )
      .filter(Boolean);
    copyText(lines.join("\n"), function () {
      setUi({ copied: true });
      setTimeout(function () {
        setUi({ copied: false });
      }, 1600);
    });
  }
  function numberField(label, value, onInput, extra, before, after) {
    return h(
      "label",
      { class: "sr-qty-field" },
      h("span", null, label),
      h(
        "span",
        { class: "sr-qty-input-row" },
        before ? h("span", { class: "sr-qty-unit" }, before) : null,
        h(
          "input",
          Object.assign(
            {
              class: "sr-input sr-input-compact",
              type: "number",
              min: "0",
              inputmode: "decimal",
              value: value,
              "aria-label": label,
              oninput: function (event) {
                onInput(event.target.value);
              },
            },
            extra,
          ),
        ),
        after ? h("span", { class: "sr-qty-unit" }, after) : null,
      ),
    );
  }
  const facts = [
    ["Category", spec.category],
    product.item ? ["Spec", product.item.sub] : null,
    ["Surface", product.regionLabel],
    ["Type", MODE_LABELS[product.item ? product.item.mode : "custom"]],
    ["Added in", "Version " + product.versionNumber],
  ].filter(Boolean);
  return modal({
    key: "product",
    open: true,
    onClose: props.onClose,
    title: productName(product),
    titleId: "sr-product-title",
    size: "wide",
    body: h(
      "div",
      { class: "sr-product-sheet" },
      h(
        "div",
        { class: "sr-product-side" },
        swatchOrChip(product.item, "product", "sr-product-swatch"),
        h(
          "dl",
          { class: "sr-facts sr-facts-stacked" },
          facts.map(function (entry) {
            return h(
              "div",
              { key: entry[0] },
              h("dt", null, entry[0]),
              h("dd", null, entry[1]),
            );
          }),
        ),
      ),
      h(
        "div",
        { class: "sr-product-main" },
        h("h3", { class: "sr-sheet-heading" }, "What it is"),
        h(
          "p",
          { class: "sr-sheet-text" },
          product.item
            ? product.item.about
            : product.notes || "A custom change described in the render notes.",
        ),
        product.renderedDescription
          ? [
              h("h3", { class: "sr-sheet-heading" }, "As rendered"),
              h("p", { class: "sr-sheet-text" }, product.renderedDescription),
            ]
          : null,
        h("h3", { class: "sr-sheet-heading" }, "Quantity"),
        h(
          "div",
          { class: "sr-qty-inputs" },
          numberField(
            "Area to cover",
            form.area,
            changeArea,
            { step: "0.1" },
            null,
            unit === "m2" ? "m²" : "sq ft",
          ),
          NEEDS_WIDTH[spec.qty.type]
            ? numberField(
                "Width",
                form.width,
                changeWidth,
                { step: "0.05" },
                null,
                "m",
              )
            : null,
          numberField(
            "Rate (optional)",
            form.rate,
            changeRate,
            { step: "1", placeholder: "0" },
            props.currency,
            "per " +
              (result.primary ? unitSingular(result.primary.unit) : "unit"),
          ),
        ),
        h(
          "p",
          { class: "sr-qty-basis" },
          basis,
          overridden
            ? h(
                "button",
                {
                  type: "button",
                  class: "sr-link-button",
                  onclick: function () {
                    props.onChange(product.id, { override: {} });
                  },
                },
                "Use the estimate",
              )
            : null,
        ),
        result.lines.length > 0
          ? h(
              "dl",
              { class: "sr-qty-lines" },
              result.lines.map(function (line) {
                return h(
                  "div",
                  { key: line[0] },
                  h("dt", null, line[0]),
                  h("dd", null, line[1]),
                );
              }),
              amount > 0
                ? h(
                    "div",
                    { key: "amount", class: "sr-qty-total" },
                    h("dt", null, "Amount"),
                    h(
                      "dd",
                      null,
                      props.currency + amount.toLocaleString("en-IN"),
                    ),
                  )
                : null,
            )
          : h("p", { class: "sr-sheet-text sr-muted" }, result.summary),
        h(
          "p",
          { class: "sr-sheet-note" },
          "Planning estimate from a single photo. Confirm with a site measurement before ordering.",
        ),
        spec.install
          ? [
              h("h3", { class: "sr-sheet-heading" }, "Installation"),
              h("p", { class: "sr-sheet-text" }, spec.install),
            ]
          : null,
        spec.care
          ? [
              h("h3", { class: "sr-sheet-heading" }, "Care"),
              h("p", { class: "sr-sheet-text" }, spec.care),
            ]
          : null,
        h(
          "div",
          { class: "sr-row-actions" },
          h(
            "button",
            {
              type: "button",
              class: "sr-button sr-button-quiet",
              onclick: copySpec,
            },
            icon("copy", 15),
            ui.copied ? " Copied" : " Copy specification",
          ),
        ),
      ),
    ),
  });
}

// props: open, onClose, products, areaUnit, currency, versionLabel, onOpenProduct,
//        onExportCsv, onBoard
export function materialsDialog(props) {
  const products = props.products;
  let total = 0;
  let body;
  if (products.length === 0) {
    body = h(
      "p",
      { class: "sr-sheet-text" },
      "No products in this version yet. Render a finish on a surface and it appears here with its quantity.",
    );
  } else {
    const rows = products.map(function (product) {
      const size = productSize(product);
      const result = takeoff(product.item, size);
      const amount = productAmount(product);
      total += amount;
      return h(
        "tr",
        { key: product.id },
        h(
          "td",
          null,
          h(
            "button",
            {
              type: "button",
              class: "sr-bom-product",
              onclick: function () {
                props.onOpenProduct(product.id);
              },
            },
            swatchOrChip(product.item, "bom", "sr-bom-swatch"),
            h(
              "span",
              null,
              h("strong", null, productName(product)),
              h(
                "span",
                { class: "sr-bom-sub" },
                productSpec(product.item).category,
              ),
            ),
          ),
        ),
        h("td", { "data-label": "Surface" }, product.regionLabel),
        h(
          "td",
          { "data-label": "Area" },
          product.status === "estimating"
            ? "Estimating…"
            : size.areaM2 > 0
              ? formatArea(size.areaM2, props.areaUnit)
              : "Not set",
        ),
        h("td", { "data-label": "Quantity" }, result.summary),
        h(
          "td",
          { "data-label": "Amount", class: "sr-number" },
          amount ? props.currency + amount.toLocaleString("en-IN") : "",
        ),
      );
    });
    body = [
      h(
        "div",
        { class: "sr-bom-scroll" },
        h(
          "table",
          { class: "sr-bom" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, "Product"),
              h("th", { scope: "col" }, "Surface"),
              h("th", { scope: "col" }, "Area"),
              h("th", { scope: "col" }, "Quantity"),
              h("th", { scope: "col", class: "sr-number" }, "Amount"),
            ),
          ),
          h("tbody", null, rows),
          total > 0
            ? h(
                "tfoot",
                null,
                h(
                  "tr",
                  null,
                  h("td", { colspan: "4" }, "Total of priced items"),
                  h(
                    "td",
                    { class: "sr-number" },
                    props.currency + total.toLocaleString("en-IN"),
                  ),
                ),
              )
            : null,
        ),
      ),
      h(
        "p",
        { class: "sr-sheet-note" },
        "Quantities are planning estimates from the photo. Open a product to correct its area or add a rate.",
      ),
      h(
        "div",
        { class: "sr-row-actions" },
        h(
          "button",
          {
            type: "button",
            class: "sr-button sr-button-quiet",
            onclick: props.onExportCsv,
          },
          icon("file-spreadsheet", 15),
          " Export CSV",
        ),
        h(
          "button",
          {
            type: "button",
            class: "sr-button sr-button-quiet",
            onclick: props.onBoard,
          },
          icon("layout-panel-top", 15),
          " Design board",
        ),
      ),
    ];
  }
  return modal({
    key: "materials",
    open: props.open,
    onClose: props.onClose,
    title: "Materials in " + props.versionLabel,
    titleId: "sr-materials-title",
    size: "wide",
    body: body,
  });
}

// props: open, onClose, canShareFiles, hasParent, hasRenders, productCount, busy, onExport
export function shareDialog(props) {
  const verb = props.canShareFiles ? "Share" : "Download";
  const actionIcon = props.canShareFiles ? "share-2" : "download";
  const options = [
    {
      id: "image",
      title: "This image",
      text: "The version on screen as a JPEG.",
      icon: "image",
      disabled: false,
    },
    {
      id: "pair",
      title: "Before and after",
      text: props.hasParent
        ? "The version it was made from next to this one."
        : "Render a finish first.",
      icon: "layout-panel-top",
      disabled: !props.hasParent,
    },
    {
      id: "board",
      title: "Design board",
      text: props.hasRenders
        ? "Original, this version and the materials list on one page."
        : "Render a finish first.",
      icon: "layout-panel-top",
      disabled: !props.hasRenders,
    },
    {
      id: "csv",
      title: "Materials list",
      text:
        props.productCount > 0
          ? "A CSV for a spreadsheet or quote."
          : "No materials in this version yet.",
      icon: "file-spreadsheet",
      disabled: props.productCount === 0,
    },
  ];
  return modal({
    key: "share",
    open: props.open,
    onClose: props.onClose,
    title: verb + " this room",
    titleId: "sr-share-title",
    size: "small",
    body: h(
      "ul",
      { class: "sr-share-list" },
      options.map(function (option) {
        return h(
          "li",
          { key: option.id },
          h(
            "button",
            {
              type: "button",
              class: "sr-share-option",
              disabled: option.disabled || props.busy === option.id,
              onclick: function () {
                props.onExport(option.id);
              },
            },
            icon(option.icon, 20),
            h(
              "span",
              null,
              h("strong", null, option.title),
              h("span", null, option.text),
            ),
            props.busy === option.id ? spinner() : icon(actionIcon, 18),
          ),
        );
      }),
    ),
  });
}

// props: open, onClose, versions, currentId, displayUrl, onSelect
export function versionsDialog(props) {
  return modal({
    key: "versions",
    open: props.open,
    onClose: props.onClose,
    title: "Versions",
    titleId: "sr-versions-title",
    size: "small",
    body: versionsStrip({
      inSheet: true,
      versions: props.versions,
      currentId: props.currentId,
      displayUrl: props.displayUrl,
      onSelect: function (id) {
        props.onSelect(id);
        props.onClose();
      },
    }),
  });
}
