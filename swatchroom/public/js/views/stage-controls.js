// Controls that float over the photo: version toolbar, hold-to-compare, render progress and
// the options bar for the Pick, Brush and Outline tools.
import { cx, h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { segmented, spinner } from "./ui.js";

// props: layout, version, canCompare, compare, onToggleCompare, onViewChange, onInspect,
// parentLabel, productCount, onOpenMaterials
export function stageToolbar(props) {
  const version = props.version;
  const narrow = props.layout === "narrow";
  if (narrow && version.isOriginal && !props.canCompare) {
    return null;
  }
  return h(
    "div",
    {
      key: "stage-toolbar",
      class: cx("sr-stage-toolbar", narrow && "is-narrow"),
      role: "toolbar",
      "aria-label": "Version view",
    },
    !narrow
      ? h(
          "span",
          { class: "sr-stage-toolbar-label sr-truncate" },
          version.isOriginal
            ? "Original photo"
            : "v" +
                version.number +
                ", " +
                version.title +
                " on " +
                version.subtitle.toLowerCase(),
        )
      : null,
    !version.isOriginal
      ? segmented({
          label: "How this version is shown",
          value: version.view,
          onChange: props.onViewChange,
          options: [
            {
              value: "blend",
              label: narrow ? "Selection" : "Selection only",
              title:
                "Only the selected surface changes. Every other pixel is the version it was made from.",
            },
            {
              value: "raw",
              label: narrow ? "Full" : "Full output",
              title: "The full image exactly as the model returned it",
            },
          ],
        })
      : null,
    version.request && !narrow
      ? h(
          "button",
          {
            type: "button",
            class: "sr-icon-button",
            "aria-label": "Show the request sent for this version",
            title: "Request details",
            onclick: props.onInspect,
          },
          icon("info", 18),
        )
      : null,
    props.canCompare
      ? h(
          "button",
          {
            type: "button",
            class: cx("sr-icon-button", props.compare && "is-active"),
            "aria-pressed": props.compare ? "true" : "false",
            "aria-label":
              "Compare with " + props.parentLabel + (narrow ? "" : " (C)"),
            title: "Compare with " + props.parentLabel + " (C)",
            onclick: props.onToggleCompare,
          },
          icon("columns-2", 18),
        )
      : null,
    !narrow
      ? h(
          "button",
          {
            type: "button",
            class: "sr-toolbar-button",
            title: "Materials and quantities in this version (P)",
            onclick: props.onOpenMaterials,
          },
          icon("clipboard-list", 16),
          " Materials",
          props.productCount > 0
            ? h("span", { class: "sr-count-pill" }, String(props.productCount))
            : null,
        )
      : null,
  );
}

// Press and hold to see the version this one was made from.
export function peekButton(props) {
  function start(event) {
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      // ignore
    }
    props.onPeek(true);
  }
  function stop(event) {
    event.stopPropagation();
    props.onPeek(false);
  }
  return h(
    "button",
    {
      key: "peek",
      type: "button",
      class: cx("sr-stage-float sr-peek", props.active && "is-active"),
      "aria-label": "Hold to see " + props.parentLabel,
      onpointerdown: start,
      onpointerup: stop,
      onpointercancel: stop,
      onpointerleave: stop,
      oncontextmenu: function (event) {
        event.preventDefault();
      },
      onkeydown: function (event) {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          props.onPeek(true);
        }
      },
      onkeyup: function () {
        props.onPeek(false);
      },
    },
    icon("eye", 16),
    h("span", null, "Hold for before"),
  );
}

export function renderProgress(props) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - props.render.startedAt) / 1000),
  );
  const total = props.render.total;
  return h(
    "div",
    {
      key: "render-progress",
      class: cx("sr-render-progress", props.raised && "is-raised"),
      role: "status",
      "aria-live": "polite",
    },
    spinner(18),
    h(
      "div",
      { class: "sr-render-progress-text" },
      h("strong", { class: "sr-truncate" }, props.render.label),
      h(
        "span",
        null,
        (props.render.stage || props.modelName) +
          ", " +
          seconds +
          "s" +
          (total > 1
            ? ", " + props.render.done + " of " + total + " ready"
            : ""),
      ),
    ),
    h(
      "button",
      {
        type: "button",
        class: "sr-button sr-button-quiet sr-button-small",
        onclick: props.onCancel,
      },
      "Cancel",
    ),
  );
}

function smallButton(label, onclick, options) {
  const settings = options || {};
  return h(
    "button",
    {
      type: "button",
      class:
        "sr-button sr-button-small " +
        (settings.primary ? "sr-button-primary" : "sr-button-quiet"),
      disabled: !!settings.disabled,
      onclick: onclick,
    },
    label,
  );
}

// props: tool, coarse, selectedLabel, brushMode, onBrushMode, brushSize, onBrushSize, onUndo,
// onRedo, canUndo, canRedo, pick, pickExclude, onPickExclude, onPickAccept, onPickReplace,
// onPickUndo, outlinePoints, onOutlineUndo, onOutlineFinish, onCancel
export function toolOptions(props) {
  const tool = props.tool;
  if (tool === "select") {
    return null;
  }
  const coarse = props.coarse;
  if (tool === "outline") {
    const count = props.outlinePoints.length;
    return h(
      "div",
      {
        key: "tool-outline",
        class: "sr-tool-options",
        role: "toolbar",
        "aria-label": "Outline options",
      },
      h(
        "span",
        { class: "sr-tool-options-text" },
        count === 0
          ? coarse
            ? "Tap around the surface to outline it."
            : "Click around the surface. Enter or double-click finishes."
          : count +
              " point" +
              (count === 1 ? "" : "s") +
              (count >= 3 ? ". Tap the first point or Finish." : ""),
      ),
      smallButton("Undo point", props.onOutlineUndo, { disabled: count === 0 }),
      smallButton("Finish", props.onOutlineFinish, {
        primary: true,
        disabled: count < 3,
      }),
      smallButton("Cancel", props.onCancel),
    );
  }
  if (tool === "brush") {
    return h(
      "div",
      {
        key: "tool-brush",
        class: "sr-tool-options",
        role: "toolbar",
        "aria-label": "Brush options",
      },
      h(
        "span",
        { class: "sr-tool-options-text" },
        props.selectedLabel
          ? "Brushing " + props.selectedLabel.toLowerCase()
          : coarse
            ? "Select one surface to brush it"
            : "Click one surface to brush it",
      ),
      segmented({
        label: "Brush mode",
        value: props.brushMode,
        onChange: props.onBrushMode,
        options: [
          { value: "add", label: "Add" },
          { value: "erase", label: "Erase" },
        ],
      }),
      h(
        "label",
        { class: "sr-range" },
        h("span", null, "Size"),
        h("input", {
          type: "range",
          min: "4",
          max: "120",
          step: "1",
          value: String(props.brushSize),
          oninput: function (event) {
            props.onBrushSize(Number(event.target.value));
          },
        }),
      ),
      h(
        "button",
        {
          type: "button",
          class: "sr-icon-button",
          "aria-label": "Undo",
          disabled: !props.canUndo,
          onclick: props.onUndo,
        },
        icon("undo-2", 16),
      ),
      h(
        "button",
        {
          type: "button",
          class: "sr-icon-button",
          "aria-label": "Redo",
          disabled: !props.canRedo,
          onclick: props.onRedo,
        },
        icon("redo-2", 16),
      ),
      smallButton("Done", props.onCancel, { primary: true }),
    );
  }
  const pick = props.pick;
  let status = "";
  if (pick.status === "loading") {
    status = pick.message || "Loading the Pick tool";
  } else if (pick.status === "error") {
    status = pick.message;
  } else if (pick.points.length === 0) {
    status = coarse
      ? "Tap the thing you want."
      : "Click the thing you want. Shift-click excludes an area.";
  } else if (pick.busy) {
    status = "Updating the selection…";
  } else {
    status =
      pick.points.length +
      " point" +
      (pick.points.length === 1 ? "" : "s") +
      ". Add more, or keep it.";
  }
  return h(
    "div",
    {
      key: "tool-pick",
      class: "sr-tool-options",
      role: "toolbar",
      "aria-label": "Pick options",
    },
    h(
      "span",
      { class: "sr-tool-options-text" },
      pick.status === "loading" ? spinner(14) : null,
      " " + status,
      h("span", { class: "sr-tool-options-engine" }, pick.engineLabel),
    ),
    coarse
      ? segmented({
          label: "Tap adds or removes",
          value: props.pickExclude ? "remove" : "add",
          onChange: function (value) {
            props.onPickExclude(value === "remove");
          },
          options: [
            { value: "add", label: "Add" },
            { value: "remove", label: "Remove" },
          ],
        })
      : null,
    smallButton("New surface", props.onPickAccept, {
      primary: true,
      disabled: !pick.preview || pick.busy,
    }),
    props.selectedLabel
      ? smallButton(
          "Replace " + props.selectedLabel.toLowerCase(),
          props.onPickReplace,
          {
            disabled: !pick.preview || pick.busy,
          },
        )
      : null,
    smallButton("Undo point", props.onPickUndo, {
      disabled: pick.points.length === 0 || pick.busy,
    }),
    smallButton("Cancel", props.onCancel),
  );
}
