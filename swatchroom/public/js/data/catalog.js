// The finish catalog. Each surface kind (wall, floor, ceiling, window, door, furniture, other)
// has groups of items. An item has:
//   id      stable key (also seeds its swatch drawing)
//   name    shown on the card
//   sub     short spec line
//   about   one sentence for the product sheet
//   mode    surface (replace the finish), add (place something on it), restyle (same object,
//           new material) or remove
//   swatch  spec for the procedural sample card (views/swatch.js)
//   prompt  the design brief sent to the render model

// Paint colours share one template.
function paint(key, name, hex, finish) {
  const finishName = finish || "Matte emulsion";
  return {
    id: "paint-" + key,
    about:
      name +
      " interior emulsion in a " +
      finishName.toLowerCase().replace(" emulsion", "") +
      " finish, close to " +
      hex +
      ".",
    name: name,
    sub: finishName,
    mode: "surface",
    swatch: { type: "paint", hex: hex },
    prompt:
      "Repaint the surface in a " +
      finishName.toLowerCase() +
      ' paint, colour "' +
      name +
      '" (close to ' +
      hex +
      "). Even coverage, realistic sheen, crisp cut-in lines at corners, trims and the ceiling line.",
  };
}

// A paint made from any colour the designer picks (custom colour tool).
export function customPaint(hex, label) {
  const clean = String(hex || "#cccccc").toUpperCase();
  const name =
    label && label.trim() !== "" ? label.trim() : "Custom colour " + clean;
  const item = paint(
    "custom-" + clean.replace("#", "").toLowerCase(),
    name,
    clean,
  );
  item.custom = true;
  return item;
}

export const CATALOG = {
  wall: [
    {
      group: `Paint`,
      items: [
        paint(`chalk`, `Chalk white`, `#ECE8DF`),
        paint(`greige`, `Warm greige`, `#CBC1B2`),
        paint(`sage`, `Sage`, `#A7B297`),
        paint(`eucalyptus`, `Eucalyptus`, `#7D998A`),
        paint(`rose`, `Dusty rose`, `#D3A79D`),
        paint(`clay`, `Baked clay`, `#B5694D`),
        paint(`turmeric`, `Turmeric ochre`, `#C99A3E`),
        paint(`butter`, `Butter`, `#EAD8A1`),
        paint(`indigo`, `Indigo`, `#34476B`, `Eggshell emulsion`),
        paint(`teal`, `Deep teal`, `#215C5E`, `Eggshell emulsion`),
        paint(`olive`, `Olive`, `#6D6A40`),
        paint(`charcoal`, `Charcoal`, `#3E3E40`, `Eggshell emulsion`),
      ],
    },
    {
      group: `Plaster and texture`,
      items: [
        {
          id: `limewash`,
          about: `Mineral lime paint brushed on in layers for a soft, chalky, cloud-like wall.`,
          name: `Limewash`,
          sub: `Soft cloudy brushwork`,
          mode: `surface`,
          swatch: {
            type: `plaster`,
            base: `#D9CDBB`,
            variant: `limewash`,
          },
          prompt: `Finish the wall in warm sand limewash with soft, cloudy, multi-directional brush movement and gentle tonal variation; matte, chalky, no gloss.`,
        },
        {
          id: `venetian`,
          about: `Polished lime plaster trowelled in thin coats and burnished to a stone-like sheen.`,
          name: `Venetian plaster`,
          sub: `Burnished, soft sheen`,
          mode: `surface`,
          swatch: {
            type: `plaster`,
            base: `#C9C6BF`,
            variant: `venetian`,
          },
          prompt: `Apply polished Venetian plaster in light dove grey with subtle marbled trowel movement and a soft burnished sheen that catches the room light.`,
        },
        {
          id: `araish`,
          about: `Traditional Rajasthani lime plaster polished to a glassy, pearl-like finish.`,
          name: `Araish lime plaster`,
          sub: `Rajasthani polished lime`,
          mode: `surface`,
          swatch: {
            type: `plaster`,
            base: `#EFE6D3`,
            variant: `araish`,
          },
          prompt: `Finish the wall in traditional Rajasthani Araish lime plaster: ivory, glass-smooth, with a pearly polished glow and faint natural mottling.`,
        },
        {
          id: `microcement-wall`,
          about: `Thin cement-polymer coating that gives a seamless, hand-trowelled concrete look.`,
          name: `Microcement`,
          sub: `Seamless trowelled`,
          mode: `surface`,
          swatch: {
            type: `plaster`,
            base: `#A9A49C`,
            variant: `microcement`,
          },
          prompt: `Cover the wall in seamless warm-grey microcement with visible hand-trowel marks, slight cloudiness and a satin finish.`,
        },
        {
          id: `brick`,
          about: `Real clay brick slips laid like a brick wall, with recessed lime mortar joints.`,
          name: `Exposed brick`,
          sub: `Lime mortar joints`,
          mode: `surface`,
          swatch: {
            type: `brick`,
            base: `#9C5A43`,
            mortar: `#D6CBB8`,
          },
          prompt: `Clad the wall in exposed handmade red-brown brick (230 x 75 mm) in stretcher bond with recessed off-white lime mortar; natural colour variation and slight edge wear.`,
        },
        {
          id: `concrete`,
          about: `Concrete-effect plaster with timber board marks, for an architectural raw wall.`,
          name: `Board-formed concrete`,
          sub: `Architectural finish`,
          mode: `surface`,
          swatch: {
            type: `plaster`,
            base: `#9D9B97`,
            variant: `concrete`,
          },
          prompt: `Make the wall board-formed architectural concrete: cool grey, horizontal timber-board imprint about 15 cm high, tiny air pockets, matte.`,
        },
      ],
    },
    {
      group: `Panels and cladding`,
      items: [
        {
          id: `fluted-oak`,
          about: `Engineered oak panels with continuous half-round flutes for a ribbed feature wall.`,
          name: `Fluted oak`,
          sub: `Vertical half-round flutes`,
          mode: `surface`,
          swatch: {
            type: `slats`,
            base: `#C49A6C`,
            gap: `#8A6544`,
            fluted: true,
          },
          prompt: `Clad the wall in natural oak fluted panelling: continuous vertical half-round flutes about 2.5 cm wide, matte lacquer, soft shadows in each groove.`,
        },
        {
          id: `walnut-slats`,
          about: `Walnut veneer slats on black acoustic felt that also soften room echo.`,
          name: `Walnut slats`,
          sub: `Acoustic battens, black felt`,
          mode: `surface`,
          swatch: {
            type: `slats`,
            base: `#6E4A33`,
            gap: `#1E1A17`,
          },
          prompt: `Clad the wall in vertical American walnut slats (about 3 cm wide, 1.5 cm gaps) over black acoustic felt, floor to ceiling, matte oil finish.`,
        },
        {
          id: `wainscoting`,
          about: `Painted MDF panel moulding and dado rail on the lower wall.`,
          name: `Wainscoting`,
          sub: `Panel moulding, painted`,
          mode: `surface`,
          swatch: {
            type: `panel`,
            base: `#E9E5DC`,
            trim: `#D6D0C4`,
          },
          prompt: `Add classic painted panel moulding (wainscoting) in soft white: rectangular frames on the lower wall up to about 1 m with a dado rail, the same white painted above.`,
        },
        {
          id: `stacked-stone`,
          about: `Natural split-stone strips set in interlocking panels for a rugged texture.`,
          name: `Stacked stone`,
          sub: `Ledgestone cladding`,
          mode: `surface`,
          swatch: {
            type: `stone`,
            base: `#9A9286`,
            vein: `#5E574E`,
            variant: `stacked`,
          },
          prompt: `Clad the wall in natural stacked ledgestone: thin horizontal strips of split grey-beige stone with deep shadow lines and a rugged 3D texture.`,
        },
        {
          id: `bookmatch`,
          about: `Two mirror-image marble slabs joined so the veining meets at the centre.`,
          name: `Book-matched marble`,
          sub: `Statement slab wall`,
          mode: `surface`,
          swatch: {
            type: `stone`,
            base: `#EEEBE6`,
            vein: `#7D7A78`,
            variant: `bookmatch`,
          },
          prompt: `Clad the wall in large book-matched white marble slabs with bold grey veining mirrored at the centre joint; honed finish with a soft sheen.`,
        },
        {
          id: `cane-panel`,
          about: `Teak frames with woven natural cane insets, a warm mid-century detail.`,
          name: `Cane and teak`,
          sub: `Woven cane inset panels`,
          mode: `surface`,
          swatch: {
            type: `cane`,
            base: `#D7B98A`,
            frame: `#8B5E3C`,
          },
          prompt: `Panel the wall with teak frames holding natural woven cane (rattan webbing) insets, warm honey tones, slight translucency in the weave.`,
        },
        {
          id: `jaali`,
          about: `CNC-cut lattice panels in a Mughal eight-point star pattern, with a lit recess.`,
          name: `Jaali screen`,
          sub: `Geometric lattice`,
          mode: `surface`,
          swatch: {
            type: `lattice`,
            base: `#E6DCCB`,
            bg: `#7C6A55`,
          },
          prompt: `Clad the wall in an ivory geometric jaali lattice (Mughal-inspired eight-point star pattern), with a softly lit warm recess behind the cut-outs.`,
        },
      ],
    },
    {
      group: `Wallpaper`,
      items: [
        {
          id: `wp-botanical`,
          about: `Large-scale banana-leaf wallpaper in deep greens.`,
          name: `Tropical botanical`,
          sub: `Banana leaf, deep green`,
          mode: `surface`,
          swatch: {
            type: `wallpaper`,
            pattern: `botanical`,
            colors: [`#1E3B30`, `#3F7454`, `#6FA27B`],
          },
          prompt: `Hang a large-scale tropical banana-leaf wallpaper in deep greens on a dark forest background; pattern repeats aligned and wraps realistically.`,
        },
        {
          id: `wp-deco`,
          about: `Metallic gold art deco fan pattern on deep navy wallpaper.`,
          name: `Art deco fans`,
          sub: `Gold line on navy`,
          mode: `surface`,
          swatch: {
            type: `wallpaper`,
            pattern: `deco`,
            colors: [`#1E2A44`, `#C8A45F`],
          },
          prompt: `Hang an art deco fan-pattern wallpaper: fine metallic gold scalloped fans on deep navy, subtle metallic sheen.`,
        },
        {
          id: `wp-buti`,
          about: `Sanganeri-style hand block-print wallpaper with small floral butis.`,
          name: `Block-print buti`,
          sub: `Hand block-print motif`,
          mode: `surface`,
          swatch: {
            type: `wallpaper`,
            pattern: `buti`,
            colors: [`#F1EADB`, `#A44A3F`, `#4C6A5A`],
          },
          prompt: `Hang a Sanganeri-style hand block-print wallpaper: small madder-red and green floral butis in a half-drop repeat on warm off-white, slightly imperfect hand-printed look.`,
        },
        {
          id: `wp-damask`,
          about: `Tone-on-tone ivory damask wallpaper with a satin pattern.`,
          name: `Tonal damask`,
          sub: `Ivory on ivory`,
          mode: `surface`,
          swatch: {
            type: `wallpaper`,
            pattern: `damask`,
            colors: [`#E7E1D4`, `#D2C8B5`],
          },
          prompt: `Hang a tone-on-tone ivory damask wallpaper with a soft satin pattern sheen, classic medallion repeat.`,
        },
        {
          id: `wp-pinstripe`,
          about: `Fine charcoal pinstripes on cream for a tailored wall.`,
          name: `Pinstripe`,
          sub: `Charcoal on cream`,
          mode: `surface`,
          swatch: {
            type: `wallpaper`,
            pattern: `pinstripe`,
            colors: [`#EDE6D6`, `#3C3B3A`],
          },
          prompt: `Hang a fine vertical pinstripe wallpaper: thin charcoal stripes every 2 cm on cream, perfectly plumb.`,
        },
        {
          id: `wp-grasscloth`,
          about: `Natural woven grass fibre wallcovering with an organic texture.`,
          name: `Grasscloth`,
          sub: `Natural woven fibre`,
          mode: `surface`,
          swatch: {
            type: `wallpaper`,
            pattern: `grasscloth`,
            colors: [`#C8B48F`, `#A88F66`],
          },
          prompt: `Hang natural grasscloth wallpaper in warm straw beige: woven horizontal fibres, visible panel seams every 90 cm, matte organic texture.`,
        },
      ],
    },
    {
      group: `Add to this wall`,
      items: [
        {
          id: `tv-unit`,
          about: `Built-in media wall: fluted wood panel, wall-mounted TV and a floating console with LED.`,
          name: `TV wall unit`,
          sub: `Fluted panel, floating console`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `tvunit`,
            base: `#D9D2C6`,
            ink: `#3B342C`,
          },
          prompt: `Add a built-in TV wall: a wall-mounted large TV centred on a vertical fluted wood panel, with a long low floating console below and a hidden warm LED strip.`,
        },
        {
          id: `gallery-wall`,
          about: `A set of framed prints in black and oak frames arranged as a gallery wall.`,
          name: `Gallery wall`,
          sub: `Mixed black frames`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `frames`,
            base: `#E8E3DA`,
            ink: `#2E2B28`,
          },
          prompt: `Add a gallery wall of 6 to 8 framed prints in thin black and oak frames, mixed sizes, aligned to a common centre line at eye level.`,
        },
        {
          id: `abstract-art`,
          about: `One large abstract canvas in earthy terracotta, ochre and cream.`,
          name: `Large abstract canvas`,
          sub: `Statement artwork`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `canvas`,
            base: `#E8E3DA`,
            ink: `#B5694D`,
          },
          prompt: `Hang one large abstract canvas (about 120 x 90 cm) with earthy terracotta, ochre and cream brushstrokes, centred at eye level.`,
        },
        {
          id: `pichwai`,
          about: `A framed Pichwai painting in the Nathdwara tradition: lotus pond and cows.`,
          name: `Pichwai painting`,
          sub: `Lotus and cows, framed`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `pichwai`,
            base: `#E8E3DA`,
            ink: `#2F4A3A`,
          },
          prompt: `Hang a large framed Pichwai painting in the Nathdwara tradition: lotus pond and cows in deep green, pink and gold, in a slim gilded frame.`,
        },
        {
          id: `round-mirror`,
          about: `A round mirror with a thin brushed-brass frame.`,
          name: `Round brass mirror`,
          sub: `Ø 90 cm`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `mirror`,
            base: `#E3DED5`,
            ink: `#B08A4A`,
          },
          prompt: `Hang a round mirror about 90 cm across with a thin brushed brass frame, reflecting the room consistently with its perspective.`,
        },
        {
          id: `shelves`,
          about: `Floating oak shelves on hidden brackets, styled with books and ceramics.`,
          name: `Floating shelves`,
          sub: `Oak, styled`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `shelves`,
            base: `#E6E0D6`,
            ink: `#9A6E45`,
          },
          prompt: `Add three staggered floating oak shelves styled with books, ceramics and a small trailing plant; hidden brackets, soft shadows below.`,
        },
        {
          id: `sconces`,
          about: `A pair of brass wall sconces with opal glass shades.`,
          name: `Wall sconces`,
          sub: `Pair, warm glow`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `sconces`,
            base: `#DCD5CA`,
            ink: `#B08A4A`,
          },
          prompt: `Add a symmetrical pair of brass wall sconces with opal glass shades, switched on, casting soft warm scallops of light on the wall.`,
        },
      ],
    },
  ],
  floor: [
    {
      group: `Wood`,
      items: [
        {
          id: `oak-planks`,
          about: `Engineered European oak planks with a matte oiled finish.`,
          name: `Light oak planks`,
          sub: `190 mm, matte oil`,
          mode: `surface`,
          swatch: {
            type: `wood`,
            base: `#C9A57A`,
            dark: `#A7835A`,
            pattern: `planks`,
          },
          prompt: `Replace the floor with light European oak planks, 190 mm wide, random lengths, matte oiled finish, subtle grain and knots; planks run toward the main vanishing point.`,
        },
        {
          id: `herringbone`,
          about: `Oak parquet blocks laid in a classic herringbone pattern.`,
          name: `Herringbone oak`,
          sub: `90 x 600 mm blocks`,
          mode: `surface`,
          swatch: {
            type: `wood`,
            base: `#B88B5C`,
            dark: `#94693F`,
            pattern: `herringbone`,
          },
          prompt: `Replace the floor with natural oak parquet in a herringbone pattern, 90 x 600 mm blocks, matte lacquer, gentle tone variation between blocks, laid in true perspective.`,
        },
        {
          id: `chevron`,
          about: `American walnut parquet cut at an angle and laid in a chevron.`,
          name: `Chevron walnut`,
          sub: `Mitred chevron`,
          mode: `surface`,
          swatch: {
            type: `wood`,
            base: `#6F4B34`,
            dark: `#523422`,
            pattern: `chevron`,
          },
          prompt: `Replace the floor with American walnut chevron parquet (mitred V points), rich chocolate tones, satin finish, laid in true perspective.`,
        },
        {
          id: `teak`,
          about: `Solid Burma teak planks with golden-brown grain and an oil finish.`,
          name: `Teak wide plank`,
          sub: `Burma teak, 220 mm`,
          mode: `surface`,
          swatch: {
            type: `wood`,
            base: `#9B6A3F`,
            dark: `#7A4F2B`,
            pattern: `wideplank`,
          },
          prompt: `Replace the floor with wide Burma teak planks, 220 mm, golden-brown with dark grain streaks, natural oil sheen.`,
        },
        {
          id: `ash`,
          about: `Ash planks in a white-oiled Scandinavian finish.`,
          name: `Bleached ash`,
          sub: `Scandinavian white oil`,
          mode: `surface`,
          swatch: {
            type: `wood`,
            base: `#DCCDB6`,
            dark: `#C2AF92`,
            pattern: `planks`,
          },
          prompt: `Replace the floor with bleached ash planks in a white-oiled Scandinavian finish, pale and airy, fine straight grain.`,
        },
      ],
    },
    {
      group: `Stone and tile`,
      items: [
        {
          id: `statuario`,
          about: `Italian Statuario marble slabs: bright white with bold grey veins, polished.`,
          name: `Statuario marble`,
          sub: `800 x 1600 mm, polished`,
          mode: `surface`,
          swatch: {
            type: `stone`,
            base: `#F1EFEB`,
            vein: `#8C8986`,
            variant: `marble`,
          },
          prompt: `Replace the floor with Italian Statuario marble in large 800 x 1600 mm slabs: bright white with bold soft-grey veins, polished with realistic reflections of the room.`,
        },
        {
          id: `kota`,
          about: `Honed Kota stone, a blue-grey limestone from Rajasthan, in square tiles.`,
          name: `Kota stone`,
          sub: `600 x 600 mm, honed`,
          mode: `surface`,
          swatch: {
            type: `stone`,
            base: `#6E7A79`,
            vein: `#566160`,
            variant: `kota`,
          },
          prompt: `Replace the floor with honed Kota stone: blue-grey Indian limestone in 600 x 600 mm squares with hairline joints, natural tonal variation and a satin sheen.`,
        },
        {
          id: `terrazzo`,
          about: `Poured terrazzo with mixed marble chips and brass divider strips.`,
          name: `Terrazzo`,
          sub: `Poured, mixed chips`,
          mode: `surface`,
          swatch: {
            type: `terrazzo`,
            base: `#E6DFD3`,
            chips: [`#B5694D`, `#7D998A`, `#3E3E40`, `#C99A3E`, `#FFFFFF`],
          },
          prompt: `Replace the floor with polished cast terrazzo: warm off-white base with mixed marble chips in rust, sage, charcoal and ochre, seamless with thin brass divider strips.`,
        },
        {
          id: `athangudi`,
          about: `Handmade Athangudi cement tiles from Chettinad with geometric florals.`,
          name: `Athangudi tiles`,
          sub: `Chettinad handmade`,
          mode: `surface`,
          swatch: {
            type: `tile`,
            pattern: `athangudi`,
            colors: [`#C9B48A`, `#8E2F2B`, `#1F4A4C`],
          },
          prompt: `Replace the floor with handmade Athangudi (Chettinad) cement tiles, 200 x 200 mm: deep red and teal geometric floral motifs on a sandy ground, slightly glossy, hand-made irregularity.`,
        },
        {
          id: `porcelain`,
          about: `Large-format matte porcelain tiles with a warm grey stone look.`,
          name: `Large-format porcelain`,
          sub: `1200 x 600 mm, matte`,
          mode: `surface`,
          swatch: {
            type: `tile`,
            pattern: `porcelain`,
            colors: [`#B9B5AE`, `#A7A39C`],
          },
          prompt: `Replace the floor with large-format matte porcelain tiles, 1200 x 600 mm, warm light grey stone look, 2 mm grout, laid in true perspective.`,
        },
        {
          id: `checker`,
          about: `Black and white marble squares laid diagonally as a checkerboard.`,
          name: `Checkerboard marble`,
          sub: `Black and white, diagonal`,
          mode: `surface`,
          swatch: {
            type: `tile`,
            pattern: `checker`,
            colors: [`#EDEBE6`, `#2A2A2B`],
          },
          prompt: `Replace the floor with a classic black and white marble checkerboard set on the diagonal, 400 mm squares, honed finish.`,
        },
        {
          id: `moroccan`,
          about: `Encaustic cement tiles in a blue, ochre and cream quatrefoil pattern.`,
          name: `Encaustic cement tile`,
          sub: `Patterned, 200 mm`,
          mode: `surface`,
          swatch: {
            type: `tile`,
            pattern: `moroccan`,
            colors: [`#E8E1D3`, `#2F5A72`, `#C99A3E`],
          },
          prompt: `Replace the floor with encaustic cement tiles in a blue, ochre and cream quatrefoil pattern, 200 x 200 mm, matte.`,
        },
        {
          id: `slate`,
          about: `Riven charcoal slate tiles with a natural cleft texture.`,
          name: `Slate`,
          sub: `Riven, charcoal`,
          mode: `surface`,
          swatch: {
            type: `stone`,
            base: `#4A4D50`,
            vein: `#36393C`,
            variant: `slate`,
          },
          prompt: `Replace the floor with riven charcoal slate tiles, 600 x 400 mm, natural cleft texture with subtle rust and green flecks.`,
        },
      ],
    },
    {
      group: `Seamless`,
      items: [
        {
          id: `microcement-floor`,
          about: `Seamless warm-grey microcement floor with a satin seal.`,
          name: `Microcement`,
          sub: `Warm grey, satin`,
          mode: `surface`,
          swatch: {
            type: `plaster`,
            base: `#B0A89D`,
            variant: `microcement`,
          },
          prompt: `Replace the floor with seamless warm-grey microcement: no joints, faint trowel clouding, satin sealer with soft reflections.`,
        },
        {
          id: `polished-concrete`,
          about: `Ground and polished concrete with a fine exposed aggregate.`,
          name: `Polished concrete`,
          sub: `Exposed aggregate`,
          mode: `surface`,
          swatch: {
            type: `plaster`,
            base: `#8F8E8B`,
            variant: `polished`,
          },
          prompt: `Replace the floor with ground and polished concrete showing fine salt-and-pepper aggregate, a few saw-cut control joints, and gentle gloss.`,
        },
        {
          id: `epoxy`,
          about: `Seamless glossy off-white resin floor.`,
          name: `Resin floor`,
          sub: `Glossy off-white`,
          mode: `surface`,
          swatch: {
            type: `plaster`,
            base: `#E7E3DB`,
            variant: `epoxy`,
          },
          prompt: `Replace the floor with seamless glossy off-white resin, mirror-like reflections of windows and furniture.`,
        },
      ],
    },
    {
      group: `Add a rug`,
      items: [
        {
          id: `rug-jute`,
          about: `A large natural jute rug with a chunky basket weave.`,
          name: `Jute rug`,
          sub: `Chunky weave`,
          mode: `add`,
          swatch: {
            type: `rug`,
            variant: `jute`,
            colors: [`#B89B6B`, `#9C8156`],
          },
          prompt: `Add a large natural jute rug with a chunky basket weave under the main furniture group, front legs resting on it.`,
        },
        {
          id: `rug-persian`,
          about: `A hand-knotted vintage-style Persian rug in red, navy and ivory.`,
          name: `Persian rug`,
          sub: `Hand-knotted, faded`,
          mode: `add`,
          swatch: {
            type: `rug`,
            variant: `persian`,
            colors: [`#8E3B32`, `#1F3A5A`, `#D9C29A`],
          },
          prompt: `Add a large faded vintage Persian rug in madder red, navy and ivory with a medallion and border, slightly worn pile.`,
        },
        {
          id: `rug-dhurrie`,
          about: `A handwoven cotton dhurrie flatweave with indigo and mustard stripes.`,
          name: `Cotton dhurrie`,
          sub: `Flatweave stripes`,
          mode: `add`,
          swatch: {
            type: `rug`,
            variant: `dhurrie`,
            colors: [`#E6DCC8`, `#3E5A7A`, `#C99A3E`],
          },
          prompt: `Add a handwoven cotton dhurrie flatweave rug in ivory with indigo and mustard stripes, flat with a slight fringe.`,
        },
        {
          id: `rug-shag`,
          about: `A cream deep-pile shag rug.`,
          name: `Cream shag`,
          sub: `Deep pile`,
          mode: `add`,
          swatch: {
            type: `rug`,
            variant: `shag`,
            colors: [`#EDE5D6`, `#D8CDB8`],
          },
          prompt: `Add a large cream deep-pile shag rug with soft irregular texture and gentle shadows under furniture edges.`,
        },
      ],
    },
  ],
  ceiling: [
    {
      group: `Finish`,
      items: [
        paint(`ceiling-white`, `Ceiling white`, `#F2F0EB`, `Flat matte`),
        paint(`ceiling-dark`, `Moody charcoal`, `#38393B`, `Flat matte`),
        paint(`ceiling-sky`, `Pale sky`, `#D9E3E6`, `Flat matte`),
        {
          id: `ceiling-concrete`,
          about: `Raw exposed concrete ceiling with formwork marks.`,
          name: `Exposed concrete`,
          sub: `Raw slab`,
          mode: `surface`,
          swatch: {
            type: `plaster`,
            base: `#9E9C98`,
            variant: `concrete`,
          },
          prompt: `Make the ceiling raw exposed concrete slab with formwork marks and slight tonal variation, matte.`,
        },
        {
          id: `ceiling-pine`,
          about: `Honey pine tongue-and-groove boards lining the ceiling.`,
          name: `Timber lining`,
          sub: `Tongue and groove pine`,
          mode: `surface`,
          swatch: {
            type: `wood`,
            base: `#D2AF80`,
            dark: `#B48E5E`,
            pattern: `tongue`,
          },
          prompt: `Line the ceiling with honey pine tongue-and-groove boards running across the room, matte clear finish.`,
        },
      ],
    },
    {
      group: `False ceiling`,
      items: [
        {
          id: `cove`,
          about: `Gypsum false ceiling with a perimeter cove hiding a warm LED strip.`,
          name: `Cove with LED`,
          sub: `Gypsum, hidden 3000K strip`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `cove`,
            base: `#ECE9E3`,
            ink: `#F2C77A`,
          },
          prompt: `Build a gypsum false ceiling with a recessed perimeter cove about 30 cm deep hiding a warm 3000K LED strip that washes light up onto the ceiling; flat white central field.`,
        },
        {
          id: `tray`,
          about: `Two-level stepped gypsum ceiling with shadow gaps and downlights.`,
          name: `Two-level tray`,
          sub: `Stepped gypsum`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `tray`,
            base: `#ECE9E3`,
            ink: `#9E978B`,
          },
          prompt: `Build a two-level stepped gypsum tray ceiling following the room outline, crisp shadow-gap edges, with a few recessed downlights in the lower band.`,
        },
        {
          id: `floating`,
          about: `Floating gypsum panel with slim recessed linear LED profiles.`,
          name: `Floating ceiling`,
          sub: `Linear profile lights`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `floating`,
            base: `#ECE9E3`,
            ink: `#F7E2B4`,
          },
          prompt: `Build a floating gypsum ceiling panel with a shadow gap around it and slim recessed linear LED profiles forming a clean geometric pattern.`,
        },
        {
          id: `coffered`,
          about: `A grid of recessed square coffers with painted beams and moulding.`,
          name: `Coffered`,
          sub: `Painted grid`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `coffered`,
            base: `#E9E6DF`,
            ink: `#B9B2A6`,
          },
          prompt: `Build a classic coffered ceiling: a grid of recessed square panels with painted white beams and fine moulding, aligned to the room walls.`,
        },
        {
          id: `beams`,
          about: `Exposed dark-stained timber beams across a white ceiling.`,
          name: `Timber beams`,
          sub: `Exposed, dark stain`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `beams`,
            base: `#EDEAE4`,
            ink: `#5A3F2C`,
          },
          prompt: `Add exposed dark-stained timber beams across the ceiling at about 1 m spacing, over a white ceiling, aligned to the room.`,
        },
        {
          id: `battens`,
          about: `Linear oak battens with black gaps and slim spotlights.`,
          name: `Wood battens`,
          sub: `Linear acoustic`,
          mode: `surface`,
          swatch: {
            type: `slats`,
            base: `#BE936A`,
            gap: `#2A2522`,
          },
          prompt: `Clad the ceiling in linear oak battens with narrow black gaps, running along the room length, with a few slim recessed spotlights between battens.`,
        },
      ],
    },
    {
      group: `Lighting`,
      items: [
        {
          id: `rattan-pendants`,
          about: `A cluster of three woven rattan dome pendants.`,
          name: `Rattan pendants`,
          sub: `Cluster of three`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `pendant-rattan`,
            base: `#ECE9E3`,
            ink: `#B48A57`,
          },
          prompt: `Hang a cluster of three woven rattan dome pendants at staggered heights, switched on with a warm glow and patterned light.`,
        },
        {
          id: `globe-pendants`,
          about: `A row of opal glass globe pendants on brass stems.`,
          name: `Glass globes`,
          sub: `Opal, brass stems`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `pendant-glass`,
            base: `#ECE9E3`,
            ink: `#B08A4A`,
          },
          prompt: `Hang a linear row of opal glass globe pendants on slim brass stems, switched on, soft even glow.`,
        },
        {
          id: `chandelier`,
          about: `A classic crystal chandelier with brass arms.`,
          name: `Crystal chandelier`,
          sub: `Classic, centred`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `chandelier`,
            base: `#ECE9E3`,
            ink: `#B08A4A`,
          },
          prompt: `Hang a classic crystal chandelier with brass arms centred on the ceiling, switched on with sparkle and soft light on the ceiling.`,
        },
        {
          id: `downlights`,
          about: `Recessed round LED downlights in an even grid.`,
          name: `Recessed downlights`,
          sub: `Grid layout`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `downlights`,
            base: `#ECE9E3`,
            ink: `#F2C77A`,
          },
          prompt: `Add evenly spaced recessed round LED downlights in a neat grid, switched on with gentle light pools on walls and floor.`,
        },
        {
          id: `track`,
          about: `A slim black ceiling track with four adjustable spotlights.`,
          name: `Track lights`,
          sub: `Black, adjustable`,
          mode: `add`,
          swatch: {
            type: `motif`,
            name: `track`,
            base: `#ECE9E3`,
            ink: `#222222`,
          },
          prompt: `Add a slim black ceiling track with four adjustable spotlights aimed at the walls, casting soft scallops.`,
        },
      ],
    },
  ],
  window: [
    {
      group: `Curtains`,
      items: [
        {
          id: `sheer-linen`,
          about: `Floor-to-ceiling sheer ivory linen curtains on a ceiling track.`,
          name: `Sheer linen`,
          sub: `Ceiling to floor`,
          mode: `add`,
          swatch: {
            type: `fabric`,
            variant: `sheer`,
            base: `#EEE7DA`,
          },
          prompt: `Dress the window with floor-to-ceiling sheer ivory linen curtains on a ceiling track, softly diffusing the daylight, natural folds.`,
        },
        {
          id: `velvet-drapes`,
          about: `Emerald velvet pinch-pleat drapes hung high and wide.`,
          name: `Velvet drapes`,
          sub: `Pinch pleat, emerald`,
          mode: `add`,
          swatch: {
            type: `fabric`,
            variant: `velvet`,
            base: `#1F5A45`,
          },
          prompt: `Dress the window with emerald velvet pinch-pleat drapes hung high and wide, pooling slightly on the floor, with rich sheen in the folds.`,
        },
        {
          id: `blackout`,
          about: `Grey blackout curtains with a wave heading.`,
          name: `Blackout grey`,
          sub: `Wave heading`,
          mode: `add`,
          swatch: {
            type: `fabric`,
            variant: `linen`,
            base: `#7D7B78`,
          },
          prompt: `Dress the window with soft grey blackout curtains with a wave heading on a ceiling track, evenly rippled folds.`,
        },
        {
          id: `ikat`,
          about: `Handloom ikat curtains in indigo and ivory.`,
          name: `Ikat handloom`,
          sub: `Indigo and ivory`,
          mode: `add`,
          swatch: {
            type: `fabric`,
            variant: `ikat`,
            base: `#2F4466`,
          },
          prompt: `Dress the window with handloom ikat curtains in indigo and ivory with blurred-edge diamond motifs, hung on a wooden rod.`,
        },
      ],
    },
    {
      group: `Blinds and shutters`,
      items: [
        {
          id: `roman`,
          about: `Oatmeal linen Roman blinds fitted inside the window frame.`,
          name: `Roman blinds`,
          sub: `Oatmeal linen`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `roman`,
            base: `#D8CCB6`,
            ink: `#B4A68C`,
          },
          prompt: `Fit oatmeal linen Roman blinds inside the window frame, lowered halfway, with neat horizontal folds.`,
        },
        {
          id: `wood-venetian`,
          about: `50 mm wooden venetian blinds with tilting slats.`,
          name: `Wooden venetian`,
          sub: `50 mm slats`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `venetian`,
            base: `#B88B5C`,
            ink: `#7E5A37`,
          },
          prompt: `Fit 50 mm wooden venetian blinds in a warm oak tone inside the window, slats half tilted, with striped daylight.`,
        },
        {
          id: `zebra`,
          about: `Day-and-night zebra roller blinds with sheer and opaque bands.`,
          name: `Zebra blinds`,
          sub: `Day and night`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `zebra`,
            base: `#E2DCD0`,
            ink: `#BDB4A3`,
          },
          prompt: `Fit beige zebra (day-and-night) roller blinds inside the window with alternating sheer and opaque bands.`,
        },
        {
          id: `shutters`,
          about: `White plantation shutters with wide adjustable louvres.`,
          name: `Plantation shutters`,
          sub: `White, louvred`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `shutters`,
            base: `#EFEDE8`,
            ink: `#C9C5BC`,
          },
          prompt: `Fit white plantation shutters with wide louvres, half open, filling the window opening.`,
        },
        {
          id: `chik`,
          about: `Traditional Indian bamboo chik blind with cotton ties.`,
          name: `Bamboo chik`,
          sub: `Traditional, rolled`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `chik`,
            base: `#C9AE78`,
            ink: `#9B7F4C`,
          },
          prompt: `Hang a traditional Indian bamboo chik blind with fine horizontal reeds and cotton tie cords, partly rolled up.`,
        },
      ],
    },
    {
      group: `Frame`,
      items: [
        {
          id: `steel-frame`,
          about: `Slim black steel window frame divided by glazing bars.`,
          name: `Black steel grid`,
          sub: `Slim glazing bars`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `metalframe`,
            base: `#C9D6DA`,
            ink: `#1E1E1E`,
          },
          prompt: `Replace the window frame with slim black steel framing divided into a grid of glazing bars, same opening size and view outside.`,
        },
        {
          id: `teak-arch`,
          about: `Solid teak window frame with an arched top.`,
          name: `Arched teak`,
          sub: `Arch top, teak frame`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `arch`,
            base: `#C9D6DA`,
            ink: `#7A4F2B`,
          },
          prompt: `Reframe the window in solid teak with an arched top section within the same opening, keeping the view outside.`,
        },
      ],
    },
  ],
  door: [
    {
      group: `Door style`,
      items: [
        {
          id: `door-teak`,
          about: `Solid teak six-panel door with an oiled finish and brass lever.`,
          name: `Teak panel door`,
          sub: `Six panel, oiled`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `door-panel`,
            base: `#8E5F38`,
            ink: `#5E3D22`,
          },
          prompt: `Replace the door with a solid teak six-panel door, oiled finish, brass lever handle, same size and swing.`,
        },
        {
          id: `door-shaker`,
          about: `Sage-painted shaker door with recessed panels and an aged brass knob.`,
          name: `Painted shaker`,
          sub: `Sage, brass knob`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `door-shaker`,
            base: `#A7B297`,
            ink: `#7F8A70`,
          },
          prompt: `Replace the door with a sage-painted shaker door with simple recessed panels and an aged brass knob.`,
        },
        {
          id: `door-fluted`,
          about: `Black metal-framed door with reeded glass.`,
          name: `Fluted glass`,
          sub: `Black metal frame`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `door-fluted`,
            base: `#C9D2D2`,
            ink: `#1E1E1E`,
          },
          prompt: `Replace the door with a slim black metal-framed door with reeded (fluted) glass, softly blurring the light behind.`,
        },
        {
          id: `door-flush`,
          about: `Flush walnut veneer door in a concealed frame with a long brass pull.`,
          name: `Walnut flush`,
          sub: `Concealed frame`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `door-flush`,
            base: `#6F4B34`,
            ink: `#C9A45F`,
          },
          prompt: `Replace the door with a flush walnut veneer door in a concealed frame, long vertical brass pull handle.`,
        },
        {
          id: `door-carved`,
          about: `Heritage Chettinad-style carved teak door with brass studs.`,
          name: `Chettinad carved`,
          sub: `Heritage teak`,
          mode: `surface`,
          swatch: {
            type: `motif`,
            name: `door-carved`,
            base: `#7A4F2B`,
            ink: `#4A2E18`,
          },
          prompt: `Replace the door with a heritage Chettinad-style carved teak door with ornate panels and brass studs.`,
        },
      ],
    },
  ],
  furniture: [
    {
      group: `Upholstery`,
      items: [
        {
          id: `boucle`,
          about: `Cream bouclé upholstery with a nubby looped texture.`,
          name: `Cream bouclé`,
          sub: `Looped texture`,
          mode: `restyle`,
          swatch: {
            type: `fabric`,
            variant: `boucle`,
            base: `#EAE2D3`,
          },
          prompt: `Reupholster in cream bouclé with a nubby looped texture; keep the exact shape, cushions and legs.`,
        },
        {
          id: `emerald-velvet`,
          about: `Emerald green velvet upholstery.`,
          name: `Emerald velvet`,
          sub: `Plush pile`,
          mode: `restyle`,
          swatch: {
            type: `fabric`,
            variant: `velvet`,
            base: `#1F5A45`,
          },
          prompt: `Reupholster in emerald green velvet with soft sheen highlights; keep the exact shape, cushions and legs.`,
        },
        {
          id: `mustard-velvet`,
          about: `Mustard velvet upholstery.`,
          name: `Mustard velvet`,
          sub: `Plush pile`,
          mode: `restyle`,
          swatch: {
            type: `fabric`,
            variant: `velvet`,
            base: `#C08E2E`,
          },
          prompt: `Reupholster in mustard velvet with soft sheen highlights; keep the exact shape, cushions and legs.`,
        },
        {
          id: `cognac`,
          about: `Aniline cognac leather upholstery that develops a patina.`,
          name: `Cognac leather`,
          sub: `Aniline, aged`,
          mode: `restyle`,
          swatch: {
            type: `fabric`,
            variant: `leather`,
            base: `#8E4F28`,
          },
          prompt: `Reupholster in aniline cognac leather with natural creasing and patina; keep the exact shape.`,
        },
        {
          id: `linen`,
          about: `Natural oatmeal linen upholstery with a slubby weave.`,
          name: `Natural linen`,
          sub: `Slubby weave`,
          mode: `restyle`,
          swatch: {
            type: `fabric`,
            variant: `linen`,
            base: `#CDBFA6`,
          },
          prompt: `Reupholster in natural oatmeal linen with a slubby weave and relaxed creases; keep the exact shape.`,
        },
      ],
    },
    {
      group: `Finish`,
      items: [
        {
          id: `walnut-veneer`,
          about: `American walnut veneer with a satin lacquer.`,
          name: `Walnut veneer`,
          sub: `Satin lacquer`,
          mode: `restyle`,
          swatch: {
            type: `wood`,
            base: `#6F4B34`,
            dark: `#523422`,
            pattern: `wideplank`,
          },
          prompt: `Change the finish to American walnut veneer with satin lacquer and continuous grain; same form and hardware positions.`,
        },
        {
          id: `white-lacquer`,
          about: `Smooth matte white lacquer, handleless.`,
          name: `Matte white lacquer`,
          sub: `Handleless`,
          mode: `restyle`,
          swatch: {
            type: `paint`,
            hex: `#EDEBE6`,
          },
          prompt: `Change the finish to smooth matte white lacquer with handleless edges; same form.`,
        },
        {
          id: `black-oak`,
          about: `Black-stained oak with visible open grain.`,
          name: `Black oak`,
          sub: `Stained, open grain`,
          mode: `restyle`,
          swatch: {
            type: `wood`,
            base: `#2E2A27`,
            dark: `#1D1A18`,
            pattern: `wideplank`,
          },
          prompt: `Change the finish to black-stained oak with visible open grain; same form.`,
        },
        {
          id: `cane-teak`,
          about: `Teak frames with woven natural cane fronts.`,
          name: `Cane and teak`,
          sub: `Woven fronts`,
          mode: `restyle`,
          swatch: {
            type: `cane`,
            base: `#D7B98A`,
            frame: `#8B5E3C`,
          },
          prompt: `Change the finish to teak frames with woven natural cane panels on the fronts; same form.`,
        },
      ],
    },
    {
      group: `Edit`,
      items: [
        {
          id: `remove`,
          about: `Removes the item and rebuilds the wall and floor behind it.`,
          name: `Remove item`,
          sub: `Rebuild what is behind`,
          mode: `remove`,
          swatch: {
            type: `motif`,
            name: `remove`,
            base: `#DAD5CC`,
            ink: `#6A645B`,
          },
          prompt: `Remove this item and reconstruct the surfaces behind it.`,
        },
      ],
    },
  ],
  other: [
    {
      group: `Edit`,
      items: [
        paint(`other-white`, `Chalk white`, `#ECE8DF`),
        paint(`other-sage`, `Sage`, `#A7B297`),
        {
          id: `other-remove`,
          about: `Removes the item and rebuilds the wall and floor behind it.`,
          name: `Remove item`,
          sub: `Rebuild what is behind`,
          mode: `remove`,
          swatch: {
            type: `motif`,
            name: `remove`,
            base: `#DAD5CC`,
            ink: `#6A645B`,
          },
          prompt: `Remove this item and reconstruct the surfaces behind it.`,
        },
      ],
    },
  ],
};
export const ROOM_STYLES = [
  {
    id: ``,
    name: `None`,
  },
  {
    id: `Japandi: warm minimalism, pale woods, linen, low contrast`,
    name: `Japandi`,
  },
  {
    id: `Scandinavian: light, airy, pale wood, soft whites`,
    name: `Scandinavian`,
  },
  {
    id: `Contemporary Indian: warm woods, brass, handcrafted textiles, earthy accents`,
    name: `Contemporary Indian`,
  },
  {
    id: `Mid-century modern: walnut, tapered legs, mustard and teal accents`,
    name: `Mid-century modern`,
  },
  {
    id: `Industrial: raw concrete, black steel, aged leather`,
    name: `Industrial`,
  },
  {
    id: `Art deco: geometric glamour, brass, velvet, marble`,
    name: `Art deco`,
  },
  {
    id: `Warm minimal: limewash, travertine, oak, soft curves`,
    name: `Warm minimal`,
  },
  {
    id: `Coastal: sandy neutrals, rattan, airy blues`,
    name: `Coastal`,
  },
  {
    id: `Biophilic: plants, natural textures, organic forms`,
    name: `Biophilic`,
  },
];

// Notes shown under the render button for each item mode.
export const MODE_NOTES = {
  surface: "Replaces the finish, locked to the selection",
  add: "Adds an element, may extend past the edge",
  restyle: "Same piece, new material",
  remove: "Removes the item and rebuilds behind it",
};

// Physical tile size for the instant WebGPU/WebGL2 renderer (server/lib/fusion.js's UV basis
// is in metres, so the material texture needs a real-world repeat size to tile correctly -
// see scripts/build-textures.js, which renders views/swatch.js's forTiling output to
// public/textures/<id>.png at this aspect ratio). Paint and other continuous finishes get a
// small, visually-arbitrary size (there is no physical repeat unit to measure - just enough
// that the subtle grain does not look obviously tiled); everything else is anchored to the
// item's own stated real-world dimensions where its sub/about/prompt text gives one (hand-
// transcribed below, not parsed at runtime), and a reasonable estimate otherwise. "motif" and
// "rug" items (whole-object compositions, not materials) and "panel" (a fixed wainscoting
// layout, not a repeating material) are deliberately left out: they never render through the
// fast path (see canFastRenderItem(), public/js/lib/fastrender/tiers.js) and always use Gemini.
const NO_TEXTURE_TYPES = new Set(["motif", "rug", "panel"]);

// [tileWidthM, tileHeightM] per swatch.type, used when an item has no size override below.
// Kept close to the texture's own 160:112 aspect ratio so the pattern is not stretched.
const TEXTURE_TYPE_DEFAULTS = {
  paint: [0.5, 0.35],
  plaster: [1.4, 1.0],
  fabric: [0.5, 0.35],
  wallpaper: [0.6, 0.42],
  stone: [1.6, 1.12],
  tile: [1.2, 0.84],
  wood: [1.5, 1.05],
  slats: [1.2, 0.85],
  cane: [0.6, 0.42],
  terrazzo: [1.4, 1.0],
  brick: [1.3, 0.9],
  lattice: [0.9, 0.63],
};

// Per-item overrides, for items whose own sub/about/prompt text states a real size (confirmed
// by grep: brick 230x75mm, oak planks 190mm, herringbone 90x600mm blocks, teak 220mm, marble
// 800x1600mm slabs, Kota stone 600x600mm, Athangudi/encaustic 200x200mm, porcelain
// 1200x600mm, checkerboard 400mm squares, slate 600x400mm, grasscloth seams every 900mm).
const TEXTURE_SIZE_OVERRIDES = {
  "oak-planks": [1.79, 1.25],
  ash: [1.79, 1.25],
  teak: [1.47, 1.03],
  "walnut-veneer": [1.47, 1.03],
  "black-oak": [1.47, 1.03],
  herringbone: [1.35, 0.945],
  chevron: [1.35, 0.945],
  "ceiling-pine": [1.45, 1.02],
  brick: [1.31, 0.84],
  statuario: [1.6, 1.12],
  bookmatch: [1.6, 1.12],
  kota: [1.8, 1.26],
  slate: [1.8, 1.2],
  athangudi: [0.8, 0.56],
  porcelain: [2.4, 1.68],
  checker: [1.6, 1.12],
  moroccan: [1.0, 0.7],
  "wp-grasscloth": [0.9, 0.63],
};

// Attaches `texture` to every tileable item, once, at module load - so any code that reads
// CATALOG directly (not just findItem()) sees it too.
(function attachTextures() {
  Object.keys(CATALOG).forEach(function (kind) {
    CATALOG[kind].forEach(function (group) {
      group.items.forEach(function (item) {
        if (item.texture) {
          return; // already attached (an item can appear in more than one kind's groups)
        }
        const type = item.swatch && item.swatch.type;
        if (!type || NO_TEXTURE_TYPES.has(type)) {
          return;
        }
        const size = TEXTURE_SIZE_OVERRIDES[item.id] || TEXTURE_TYPE_DEFAULTS[type];
        if (!size) {
          return;
        }
        item.texture = {
          url: "/textures/" + item.id + ".png",
          tileWidthM: size[0],
          tileHeightM: size[1],
        };
      });
    });
  });
})();

let itemIndex = null;

function buildIndex() {
  itemIndex = {};
  Object.keys(CATALOG).forEach(function (kind) {
    CATALOG[kind].forEach(function (group) {
      group.items.forEach(function (item) {
        if (!itemIndex[item.id]) {
          itemIndex[item.id] = { item: item, kind: kind, group: group.group };
        }
      });
    });
  });
}

// Look up a catalog item by id. Custom paint colours are rebuilt from their id.
export function findItem(id) {
  if (!id) {
    return null;
  }
  if (!itemIndex) {
    buildIndex();
  }
  if (itemIndex[id]) {
    return itemIndex[id].item;
  }
  const custom = /^paint-custom-([0-9a-f]{6})$/i.exec(id);
  if (custom) {
    return customPaint("#" + custom[1]);
  }
  return null;
}

// Which surface kind an item belongs to ("wall", "floor", ...). Custom paints work on any kind.
export function findItemKind(id) {
  if (!itemIndex) {
    buildIndex();
  }
  if (itemIndex[id]) {
    return itemIndex[id].kind;
  }
  return null;
}

// "kind/Group" key used by the take-off tables.
export function findItemGroupKey(id) {
  if (!itemIndex) {
    buildIndex();
  }
  if (itemIndex[id]) {
    return itemIndex[id].kind + "/" + itemIndex[id].group;
  }
  if (/^paint-custom-/.test(id)) {
    return "wall/Paint";
  }
  return "";
}

// Free-text search across one kind's catalog (name, spec line and description).
export function searchCatalog(kind, query) {
  const groups = CATALOG[kind] || CATALOG.other;
  const words = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return groups;
  }
  const results = [];
  groups.forEach(function (group) {
    const items = group.items.filter(function (item) {
      const text = (
        item.name +
        " " +
        item.sub +
        " " +
        item.about +
        " " +
        group.group
      ).toLowerCase();
      return words.every(function (word) {
        return text.indexOf(word) !== -1;
      });
    });
    if (items.length > 0) {
      results.push({ group: group.group, items: items });
    }
  });
  return results;
}
