// The list of detected surfaces, grouped by kind, plus the editing tools.
import { cx, h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { spinner } from "./ui.js";
import { KINDS, KIND_INFO, isSmallRegion } from "../lib/regions.js";

export const TOOLS = [
  {
    id: "select",
    label: "Select",
    key: "V",
    icon: "mouse-pointer-2",
    help: "Tap or click surfaces",
  },
  {
    id: "pick",
    label: "Pick",
    key: "W",
    icon: "wand-sparkles",
    help: "Tap anything to cut it out as a new surface",
  },
  {
    id: "brush",
    label: "Brush",
    key: "B",
    icon: "brush",
    help: "Paint pixels into or out of the selected surface",
  },
  {
    id: "outline",
    label: "Outline",
    key: "L",
    icon: "lasso-select",
    help: "Draw around a surface the scan missed",
  },
];

function share(region) {
  return (
    Math.max(0.1, region.areaShare * 100).toFixed(
      region.areaShare < 0.1 ? 1 : 0,
    ) + "%"
  );
}

function dot(color) {
  return h("span", {
    class: "sr-dot",
    style: { background: "rgb(" + color.join(",") + ")" },
    "aria-hidden": "true",
  });
}

export function toolRow(props) {
  return h(
    "div",
    { class: "sr-tool-row", role: "radiogroup", "aria-label": "Tools" },
    TOOLS.map(function (tool) {
      const active = props.tool === tool.id;
      return h(
        "button",
        {
          key: tool.id,
          type: "button",
          role: "radio",
          "aria-checked": active ? "true" : "false",
          class: cx("sr-tool", active && "is-active"),
          disabled: tool.id !== "select" && (!props.scan || props.busy),
          title: tool.help + (props.coarse ? "" : " (" + tool.key + ")"),
          onclick: function () {
            props.onTool(tool.id);
          },
        },
        icon(tool.icon, 17),
        h("span", null, tool.label),
      );
    }),
    h(
      "button",
      {
        key: "map",
        type: "button",
        class: cx("sr-tool", props.showMap && "is-active"),
        "aria-pressed": props.showMap ? "true" : "false",
        disabled: !props.scan || props.scan.regions.length === 0,
        title: "Tint every surface" + (props.coarse ? "" : " (M)"),
        onclick: props.onToggleMap,
      },
      icon("layers", 17),
      h("span", null, "Map"),
    ),
  );
}

function surfaceItem(props, region) {
  const selected = props.selectedIds.indexOf(region.id) !== -1;
  return h(
    "li",
    { key: region.id },
    h(
      "button",
      {
        type: "button",
        class: cx(
          "sr-surface",
          selected && "is-selected",
          props.hoverId === region.id && "is-hover",
        ),
        "aria-pressed": selected ? "true" : "false",
        onmouseenter: function () {
          props.onHover(region.id);
        },
        onmouseleave: function () {
          props.onHover(null);
        },
        onfocus: function () {
          props.onHover(region.id);
        },
        onblur: function () {
          props.onHover(null);
        },
        onclick: function (event) {
          props.onSelect(
            region.id,
            event.shiftKey || event.ctrlKey || event.metaKey,
          );
        },
      },
      dot(region.color),
      h("span", { class: "sr-surface-name sr-truncate" }, region.label),
      props.productRegions && props.productRegions[region.id]
        ? h(
            "span",
            { class: "sr-badge", title: props.productRegions[region.id] },
            "New",
          )
        : null,
      h("span", { class: "sr-surface-share" }, share(region)),
    ),
  );
}

// props: hasPhoto, scan, scanState, hoverId, selectedIds, onHover, onSelect, onSelectMany,
// onRescan, tool, onTool, showMap, onToggleMap, busy, productRegions, hideSmall, coarse,
// onUndo, onRedo, canUndo, canRedo, showSmall, onToggleSmall, variant ("column" | "peek")
export function surfacesView(props) {
  const scan = props.scan;
  const regions = scan ? scan.regions : [];
  const small = props.hideSmall
    ? regions.filter(function (region) {
        return (
          isSmallRegion(region) && props.selectedIds.indexOf(region.id) === -1
        );
      })
    : [];
  const groups = KINDS.map(function (kind) {
    return {
      kind: kind,
      regions: regions
        .filter(function (region) {
          return region.kind === kind && small.indexOf(region) === -1;
        })
        .sort(function (a, b) {
          return b.count - a.count;
        }),
    };
  }).filter(function (group) {
    return group.regions.length > 0;
  });
  const scanState = props.scanState;
  const compact = props.variant === "peek";
  const children = [toolRow(props)];

  if (!props.hasPhoto) {
    children.push(
      h(
        "p",
        { class: "sr-empty-note" },
        "Surfaces appear here once a photo is mapped.",
      ),
    );
  }
  if (scanState.status === "running") {
    const skeletons = [];
    if (!compact) {
      for (let index = 0; index < 5; index += 1) {
        skeletons.push(
          h("div", {
            class: "sr-skeleton",
            style: { width: 70 + ((index * 37) % 30) + "%" },
          }),
        );
      }
    }
    children.push(
      h(
        "div",
        { class: "sr-surface-loading", "aria-live": "polite" },
        h(
          "p",
          { class: "sr-status-line" },
          spinner(14),
          " ",
          scanState.stage || "Mapping surfaces",
        ),
        skeletons,
      ),
    );
  }
  if (scanState.status === "error") {
    children.push(
      h(
        "div",
        { class: "sr-problem", role: "alert" },
        h("p", null, scanState.error),
        h(
          "button",
          {
            type: "button",
            class: "sr-button sr-button-quiet",
            onclick: props.onRescan,
          },
          icon("refresh-cw", 15),
          " Scan again",
        ),
        h(
          "p",
          { class: "sr-note" },
          "You can still mark surfaces with Pick or Outline.",
        ),
      ),
    );
  }
  if (scanState.status === "empty" && regions.length === 0) {
    children.push(
      h(
        "div",
        { class: "sr-problem" },
        h(
          "p",
          null,
          "No surfaces were found. Try a wider shot, scan again, or outline one by hand.",
        ),
      ),
    );
  }
  if (scanState.status !== "running" && compact && regions.length > 0) {
    const chips = [];
    groups.forEach(function (group) {
      group.regions.forEach(function (region) {
        const selected = props.selectedIds.indexOf(region.id) !== -1;
        chips.push(
          h(
            "button",
            {
              key: region.id,
              role: "listitem",
              type: "button",
              class: cx("sr-chip", selected && "is-selected"),
              onclick: function () {
                props.onSelect(region.id, false);
              },
            },
            dot(region.color),
            region.label,
          ),
        );
      });
    });
    children.push(
      h(
        "div",
        { class: "sr-chip-scroll", role: "list", "aria-label": "Surfaces" },
        chips,
      ),
    );
  }
  if (scanState.status !== "running" && !compact) {
    const sections = groups.map(function (group) {
      const ids = group.regions.map(function (region) {
        return region.id;
      });
      const allSelected = ids.every(function (id) {
        return props.selectedIds.indexOf(id) !== -1;
      });
      return h(
        "section",
        {
          key: group.kind,
          class: "sr-surface-group",
          "aria-label": KIND_INFO[group.kind].plural,
        },
        h(
          "h3",
          { class: "sr-group-title" },
          h("span", null, KIND_INFO[group.kind].plural),
          h("span", { class: "sr-count" }, String(group.regions.length)),
          group.regions.length > 1
            ? h(
                "button",
                {
                  type: "button",
                  class: "sr-link-button",
                  onclick: function () {
                    props.onSelectMany(allSelected ? [] : ids);
                  },
                },
                allSelected ? "Clear" : "Select all",
              )
            : null,
        ),
        h(
          "ul",
          { class: "sr-surface-list" },
          group.regions.map(function (region) {
            return surfaceItem(props, region);
          }),
        ),
      );
    });
    if (small.length > 0) {
      sections.push(
        h(
          "section",
          { key: "small", class: "sr-surface-group" },
          h(
            "button",
            {
              type: "button",
              class: "sr-group-toggle",
              "aria-expanded": props.showSmall ? "true" : "false",
              onclick: props.onToggleSmall,
            },
            h("span", null, "Small items"),
            h("span", { class: "sr-count" }, String(small.length)),
            icon("chevron-down", 15, {
              class: props.showSmall ? "is-flipped" : "",
            }),
          ),
          props.showSmall
            ? h(
                "ul",
                { class: "sr-surface-list" },
                small.map(function (region) {
                  return surfaceItem(props, region);
                }),
              )
            : null,
        ),
      );
    }
    children.push(h("div", { class: "sr-surface-groups" }, sections));
  }
  if (!compact && props.hasPhoto) {
    children.push(
      h(
        "div",
        { class: "sr-surface-foot" },
        h(
          "button",
          {
            type: "button",
            class: "sr-icon-text-button",
            disabled: !props.canUndo,
            title: "Undo the last surface edit (Ctrl+Z)",
            onclick: props.onUndo,
          },
          icon("undo-2", 15),
          " Undo",
        ),
        h(
          "button",
          {
            type: "button",
            class: "sr-icon-text-button",
            disabled: !props.canRedo,
            title: "Redo (Ctrl+Shift+Z)",
            onclick: props.onRedo,
          },
          icon("redo-2", 15),
          " Redo",
        ),
        h(
          "button",
          {
            type: "button",
            class: "sr-icon-text-button",
            disabled: scanState.status === "running" || props.busy,
            title: "Scan this version again",
            onclick: props.onRescan,
          },
          icon("refresh-cw", 15),
          " Rescan",
        ),
      ),
    );
  }
  return h(
    "div",
    { class: cx("sr-surfaces", compact && "is-compact") },
    children,
  );
}
