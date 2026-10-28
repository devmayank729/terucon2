// The finish catalogue for the selected surface(s), with search, group tabs, custom colours
// and the render controls.
import { cx, h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { segmented, spinner } from "./ui.js";
import { swatchMarkup } from "./swatch.js";
import {
  CATALOG,
  MODE_NOTES,
  ROOM_STYLES,
  customPaint,
  findItem,
  searchCatalog,
} from "../data/catalog.js";
import { KINDS, KIND_INFO } from "../lib/regions.js";

function swatchBox(item, place, className) {
  return h("span", {
    class: className,
    html: swatchMarkup(item.swatch, item.id, place),
  });
}

function tile(item, selected, onSelect, place) {
  return h(
    "button",
    {
      key: place + item.id,
      type: "button",
      class: cx("sr-tile", selected && "is-selected"),
      "aria-pressed": selected ? "true" : "false",
      title: item.about,
      onclick: function () {
        onSelect(item.id);
      },
    },
    h(
      "span",
      { class: "sr-tile-swatch" },
      h("span", {
        class: "sr-tile-art",
        html: swatchMarkup(item.swatch, item.id, "tile"),
      }),
      selected
        ? h(
            "span",
            { class: "sr-tile-check", "aria-hidden": "true" },
            icon("check", 14, { strokeWidth: 2.5 }),
          )
        : null,
    ),
    h("span", { class: "sr-tile-name" }, item.name),
    h("span", { class: "sr-tile-sub" }, item.sub),
  );
}

function colourTile(onPick) {
  let input = null;
  return h(
    "span",
    { key: "colour-tile", class: "sr-tile sr-tile-colour" },
    h(
      "button",
      {
        type: "button",
        class: "sr-tile-colour-button",
        onclick: function () {
          if (input) {
            input.click();
          }
        },
      },
      h(
        "span",
        { class: "sr-tile-swatch sr-tile-swatch-empty" },
        icon("palette", 22, { strokeWidth: 1.5 }),
      ),
      h("span", { class: "sr-tile-name" }, "Any colour"),
      h("span", { class: "sr-tile-sub" }, "Pick a paint colour"),
    ),
    h("input", {
      type: "color",
      class: "sr-visually-hidden",
      value: "#a7b297",
      "aria-label": "Choose a custom paint colour",
      onchange: function (event) {
        onPick(event.target.value);
      },
      ref: function (element) {
        input = element;
      },
    }),
  );
}

// Catalogue groups for a kind of surface: recent finishes first, custom colours in Paint.
export function finishGroups(kind, query, customColors, recentIds) {
  const found = searchCatalog(kind, query).map(function (group) {
    return { group: group.group, items: group.items.slice() };
  });
  const customItems = (customColors || []).map(function (hex) {
    return customPaint(hex);
  });
  const paintGroup = found.find(function (group) {
    return group.group === "Paint";
  });
  if (paintGroup && customItems.length > 0 && query.trim() === "") {
    paintGroup.items = customItems.concat(paintGroup.items);
  }
  if (query.trim() === "" && recentIds && recentIds.length > 0) {
    const kindItems = {};
    (CATALOG[kind] || []).forEach(function (group) {
      group.items.forEach(function (item) {
        kindItems[item.id] = true;
      });
    });
    const recent = recentIds
      .filter(function (id) {
        return kindItems[id] || /^paint-custom-/.test(id);
      })
      .map(findItem)
      .filter(Boolean)
      .slice(0, 8);
    if (recent.length > 1) {
      found.unshift({ group: "Recent", items: recent });
    }
  }
  return found;
}

// props: region, selectedRegions, onToggleRegion, catalogKind, onCatalogKindChange, itemId,
// onSelectItem, customColors, onAddCustomColor, recentIds, currentProduct, onOpenProduct,
// productHeadline, onClose, notes, onNotesChange, style, onStyleChange, optionCount,
// onOptionCountChange, onRender, rendering, scanReady, coarse, modelName, baseLabel, short,
// query, tab, onQuery, onTab, variant ("column" | "expanded" | "peek")
export function finishesView(props) {
  const region = props.region;
  const kind = props.catalogKind || region.kind;
  const query = props.query || "";
  const tab = props.tab || "All";
  const variant = props.variant || "column";
  const isRail = variant === "peek";
  const isColumn = variant === "column";
  const groups = finishGroups(kind, query, props.customColors, props.recentIds);
  const tabs = ["All"].concat(
    groups.map(function (group) {
      return group.group;
    }),
  );
  const visibleGroups =
    tab === "All"
      ? groups
      : groups.filter(function (group) {
          return group.group === tab;
        });
  const hasPaintGroup = groups.some(function (group) {
    return group.group === "Paint";
  });
  const showColourTile =
    !query && hasPaintGroup && (tab === "All" || tab === "Paint");
  const item = props.itemId ? findItem(props.itemId) : null;
  const multi = props.selectedRegions && props.selectedRegions.length > 1;

  const header = h(
    "div",
    { class: "sr-finish-head" },
    h(
      "div",
      { class: "sr-finish-title-row" },
      h("span", {
        class: "sr-dot sr-dot-large",
        style: { background: "rgb(" + region.color.join(",") + ")" },
        "aria-hidden": "true",
      }),
      h(
        "h2",
        { class: "sr-finish-title sr-truncate", tabindex: "-1" },
        region.label,
      ),
      h(
        "button",
        {
          type: "button",
          class: "sr-icon-button",
          "aria-label": "Close finishes",
          onclick: props.onClose,
        },
        icon("x", 18),
      ),
    ),
    multi && !isRail
      ? h(
          "div",
          { class: "sr-selection-chips", "aria-label": "Selected surfaces" },
          props.selectedRegions.map(function (part) {
            return h(
              "span",
              { key: part.id, class: "sr-chip sr-chip-small" },
              h("span", {
                class: "sr-dot",
                style: { background: "rgb(" + part.color.join(",") + ")" },
                "aria-hidden": "true",
              }),
              part.label,
              h(
                "button",
                {
                  type: "button",
                  "aria-label": "Remove " + part.label + " from the selection",
                  onclick: function () {
                    props.onToggleRegion(part.id);
                  },
                },
                icon("x", 12),
              ),
            );
          }),
        )
      : null,
    !isRail
      ? h(
          "div",
          { class: "sr-finish-meta" },
          h(
            "label",
            { htmlFor: "sr-kind", class: "sr-meta-label" },
            multi ? "Finishes for" : "Treat as",
          ),
          h(
            "select",
            {
              id: "sr-kind",
              class: "sr-input sr-input-compact",
              value: kind,
              onchange: function (event) {
                props.onCatalogKindChange(event.target.value);
              },
            },
            KINDS.map(function (value) {
              return h(
                "option",
                { key: value, value: value },
                KIND_INFO[value].singular,
              );
            }),
          ),
          h(
            "span",
            { class: "sr-meta-share" },
            (region.areaShare * 100).toFixed(region.areaShare < 0.1 ? 1 : 0) +
              "% of frame",
          ),
        )
      : null,
    props.currentProduct
      ? h(
          "button",
          {
            type: "button",
            class: "sr-current-product",
            onclick: function () {
              props.onOpenProduct(props.currentProduct.id);
            },
          },
          props.currentProduct.item
            ? swatchBox(
                props.currentProduct.item,
                "current",
                "sr-current-swatch",
              )
            : h(
                "span",
                { class: "sr-current-swatch" },
                h("span", { class: "sr-custom-chip" }),
              ),
          h(
            "span",
            { class: "sr-current-text" },
            h("span", null, "In this version"),
            h(
              "strong",
              { class: "sr-truncate" },
              props.currentProduct.item
                ? props.currentProduct.item.name
                : "Custom edit",
            ),
          ),
          h(
            "span",
            { class: "sr-current-qty sr-truncate" },
            props.productHeadline(props.currentProduct),
          ),
          icon("chevron-right", 16),
        )
      : null,
  );

  const tabsRow = h(
    "div",
    { class: "sr-tabs-scroll", role: "tablist", "aria-label": "Finish groups" },
    tabs.map(function (name) {
      return h(
        "button",
        {
          key: name,
          type: "button",
          role: "tab",
          "aria-selected": tab === name ? "true" : "false",
          class: cx("sr-tab", tab === name && "is-active"),
          onclick: function () {
            props.onTab(name);
          },
        },
        name,
      );
    }),
  );

  const searchRow = h(
    "label",
    { class: "sr-search" },
    icon("search", 16),
    h("input", {
      type: "search",
      class: "sr-search-input",
      placeholder:
        "Search " + KIND_INFO[kind].singular.toLowerCase() + " finishes",
      value: query,
      "data-search": "finishes",
      oninput: function (event) {
        props.onQuery(event.target.value);
      },
    }),
    query
      ? h(
          "button",
          {
            type: "button",
            class: "sr-icon-button sr-icon-button-small",
            "aria-label": "Clear search",
            onclick: function () {
              props.onQuery("");
            },
          },
          icon("x", 14),
        )
      : null,
  );

  if (isRail) {
    const railItems = [];
    visibleGroups.forEach(function (group) {
      group.items.forEach(function (entry) {
        if (railItems.indexOf(entry) === -1) {
          railItems.push(entry);
        }
      });
    });
    return h(
      "div",
      { class: "sr-finishes is-rail" },
      tabsRow,
      h(
        "div",
        {
          class: "sr-rail",
          role: "list",
          "aria-label": "Finishes",
          "data-scroll": "finishes",
        },
        showColourTile ? colourTile(props.onAddCustomColor) : null,
        railItems.map(function (entry) {
          return tile(
            entry,
            entry.id === props.itemId,
            props.onSelectItem,
            "rail-",
          );
        }),
      ),
    );
  }

  const groupSections = visibleGroups.map(function (group) {
    return h(
      "section",
      {
        key: "group-" + group.group,
        class: "sr-finish-group",
        "aria-label": group.group,
      },
      tab === "All" || group.group === "Recent"
        ? h("h3", { class: "sr-group-title" }, group.group)
        : null,
      h(
        "div",
        { class: "sr-tile-grid" },
        group.group === "Paint" && showColourTile
          ? colourTile(props.onAddCustomColor)
          : null,
        group.items.map(function (entry) {
          return tile(
            entry,
            entry.id === props.itemId,
            props.onSelectItem,
            group.group + "-",
          );
        }),
      ),
    );
  });

  return h(
    "div",
    {
      class: "sr-finishes is-" + variant,
      "data-scroll": isColumn ? "finishes" : null,
    },
    isColumn ? header : null,
    h(
      "div",
      { class: "sr-finish-tools", "data-finish-tools": "" },
      searchRow,
      tabsRow,
    ),
    h(
      "div",
      {
        class: "sr-finish-scroll",
        "data-scroll": isColumn ? null : "finishes",
      },
      visibleGroups.length === 0
        ? h(
            "p",
            { class: "sr-empty-note" },
            "No finishes match “" + query + "”.",
          )
        : null,
      groupSections,
      variant === "expanded" || (isColumn && props.short)
        ? renderOptions(props, false)
        : null,
    ),
    isColumn
      ? h(
          "div",
          { class: "sr-finish-foot" },
          !props.short ? renderOptions(props, true) : null,
          renderButton(props, item),
          !props.short
            ? h(
                "p",
                { class: "sr-foot-note" },
                (item ? MODE_NOTES[item.mode] + ". " : "") +
                  props.modelName +
                  " edits " +
                  props.baseLabel +
                  ".",
              )
            : null,
        )
      : null,
  );
}

// Phone sheet header for the selected surface: name, "treat as" pill, edit shape, close.
// props: region, subtitle, kind, multi, onKindChange, onEditShape, editingShape, onClose
export function finishHeader(props) {
  const region = props.region;
  return h(
    "div",
    { class: "sr-sheet-title-row" },
    h("span", {
      class: "sr-dot sr-dot-large",
      style: { background: "rgb(" + region.color.join(",") + ")" },
      "aria-hidden": "true",
    }),
    h(
      "div",
      { class: "sr-sheet-titles" },
      h("h2", { class: "sr-finish-title sr-truncate" }, region.label),
      props.onKindChange
        ? h(
            "span",
            { class: "sr-sheet-subtitle sr-kind-line" },
            h(
              "label",
              { class: "sr-kind-pick" },
              h(
                "span",
                { class: "sr-visually-hidden" },
                props.multi ? "Finishes for" : "Treat as",
              ),
              h(
                "select",
                {
                  value: props.kind,
                  onchange: function (event) {
                    props.onKindChange(event.target.value);
                  },
                },
                KINDS.map(function (value) {
                  return h(
                    "option",
                    { key: value, value: value },
                    KIND_INFO[value].singular,
                  );
                }),
              ),
              h(
                "span",
                { "aria-hidden": "true" },
                KIND_INFO[props.kind].singular,
              ),
              icon("chevron-down", 13),
            ),
            h("span", { class: "sr-truncate" }, props.subtitle),
          )
        : h("span", { class: "sr-sheet-subtitle sr-truncate" }, props.subtitle),
    ),
    props.onEditShape
      ? h(
          "button",
          {
            type: "button",
            class: cx("sr-icon-button", props.editingShape && "is-active"),
            "aria-label": "Edit the shape of this surface",
            "aria-pressed": props.editingShape ? "true" : "false",
            title: "Edit shape",
            onclick: props.onEditShape,
          },
          icon("brush", 18),
        )
      : null,
    h(
      "button",
      {
        type: "button",
        class: "sr-icon-button",
        "aria-label": "Close finishes",
        onclick: props.onClose,
      },
      icon("x", 20),
    ),
  );
}

export function renderOptions(props, compact) {
  return h(
    "div",
    { class: cx("sr-render-options", compact && "is-compact") },
    h(
      "label",
      {
        htmlFor: "sr-notes",
        class: compact ? "sr-visually-hidden" : "sr-field-label",
      },
      "Notes for this surface",
    ),
    h("textarea", {
      id: "sr-notes",
      class: "sr-input sr-notes",
      rows: compact ? "1" : "2",
      value: props.notes,
      placeholder: compact
        ? "Notes for this surface (optional)"
        : "For example: keep the switchboard, warmer tone",
      oninput: function (event) {
        props.onNotesChange(event.target.value);
      },
    }),
    h(
      "div",
      { class: "sr-render-row" },
      h(
        "label",
        { class: "sr-inline-field sr-inline-grow", htmlFor: "sr-style" },
        h("span", null, "Style"),
        h(
          "select",
          {
            id: "sr-style",
            class: "sr-input sr-input-compact",
            value: props.style,
            onchange: function (event) {
              props.onStyleChange(event.target.value);
            },
          },
          ROOM_STYLES.map(function (style) {
            return h(
              "option",
              { key: style.name, value: style.id },
              style.name,
            );
          }),
        ),
      ),
      h(
        "div",
        { class: "sr-inline-field" },
        h("span", { id: "sr-options-label" }, "Options"),
        segmented({
          label: "Number of options",
          value: props.optionCount,
          onChange: props.onOptionCountChange,
          options: [
            { value: 1, label: "1" },
            { value: 2, label: "2" },
            { value: 3, label: "3" },
          ],
        }),
      ),
    ),
  );
}

export function renderButton(props, item) {
  const hasNotes = props.notes && props.notes.trim() !== "";
  const ready = props.scanReady && !props.rendering && (item || hasNotes);
  let label = "Choose a finish to render";
  if (props.rendering) {
    label = "Rendering…";
  } else if (item) {
    label = "Render " + item.name.toLowerCase();
  } else if (hasNotes) {
    label = "Render notes";
  }
  return h(
    "button",
    {
      type: "button",
      class: "sr-button sr-button-primary sr-button-wide sr-button-render",
      disabled: !ready,
      onclick: props.onRender,
    },
    props.rendering ? spinner() : icon("sparkles", 16),
    h("span", { class: "sr-truncate" }, label),
    !props.coarse && ready
      ? h("kbd", { class: "sr-kbd-hint" }, "Ctrl ↵")
      : null,
  );
}
