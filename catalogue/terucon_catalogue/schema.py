"""The material profile Gemini fills in for every catalogue crop, the prompts that ask for it, and the text that is embedded.

# Ported from terucon-cat-1.ipynb (cell 5). Definitions are copied verbatim except where marked "PORT:".
The prompts and the schema are part of the caption version (config.compute_caption_version): editing a word here changes it.
"""
from __future__ import annotations

from enum import Enum
from typing import List

from pydantic import BaseModel, Field


class MaterialCategory(str, Enum):
    TEXTILE_FABRIC = "textile_fabric"
    LEATHER = "leather"
    WOOD_VENEER = "wood_veneer"
    SOLID_WOOD = "solid_wood"
    LAMINATE = "laminate"
    STONE = "stone"
    CERAMIC_TILE = "ceramic_tile"
    METAL = "metal"
    GLASS = "glass"
    PLASTIC_POLYMER = "plastic_polymer"
    WALLCOVERING_PAPER = "wallcovering_paper"
    RUBBER_VINYL = "rubber_vinyl"
    CARPET_RUG = "carpet_rug"
    COMPOSITE = "composite"
    OTHER = "other"


class SurfaceFinish(str, Enum):
    MATTE = "matte"
    SATIN = "satin"
    SEMI_GLOSS = "semi_gloss"
    HIGH_GLOSS = "high_gloss"
    BRUSHED = "brushed"
    EMBOSSED = "embossed"
    WOVEN = "woven"
    KNITTED = "knitted"
    TEXTURED = "textured"
    POLISHED = "polished"
    HONED = "honed"
    HAMMERED = "hammered"
    PERFORATED = "perforated"
    LACQUERED = "lacquered"
    NATURAL_UNFINISHED = "natural_unfinished"
    OTHER = "other"


class MaterialProfile(BaseModel):
    material_category: MaterialCategory = Field(description="Primary material family visible in the swatch.")
    material_subtype: str = Field(description="Specific material, e.g. 'boucle wool blend', 'quarter-sawn oak veneer'.")
    surface_finish: SurfaceFinish = Field(description="Dominant surface finish.")
    secondary_finishes: List[SurfaceFinish] = Field(description="Other visible finishes; empty list if none.")
    grain_or_pattern_description: str = Field(description="Weave, grain, vein or print geometry and direction.")
    pattern_scale: str = Field(description="Approximate physical scale of the repeat or grain, in millimetres.")
    color_palette_description: str = Field(description="Base tone, secondary tones and variation, with hex codes.")
    specular_behavior: str = Field(description="Highlight size and sharpness, sheen, anisotropy, roughness.")
    micro_surface_feel: str = Field(description="Tactile micro-relief: fibre fuzz, pores, embossing depth.")
    search_keywords: List[str] = Field(description="8-15 lowercase retrieval keywords.")
    nano_banana_render_prompt: str = Field(description="120-220 word material-only rendering prompt.")
    confidence: float = Field(description="0-1 self-assessed confidence in the material identification.")


CAPTION_SYSTEM_PROMPT = """You are a senior materials scientist and CGI look-development artist cataloguing physical
product swatches (fabrics, veneers, laminates, stone, tiles, metals, leathers, wallcoverings).
You receive ONE cropped catalogue photo and its product code. Describe only what is visible.

Rules:
- Never invent brand names, manufacturers or text. The product code is context only.
- Treat the measured dominant colours as ground truth for hue; express tones with hex codes.
- grain_or_pattern_description: geometry (twill, herringbone, cathedral grain, veining), direction, regularity.
- pattern_scale: estimate the real-world repeat or grain spacing in millimetres.
- nano_banana_render_prompt: 120-220 words, present tense, written as an instruction to an image model that must
  reproduce THIS exact material on another object. Cover weave/grain geometry and direction, repeat scale in mm,
  yarn/fibre or pore structure, relief depth, roughness, specular highlight size and sharpness, anisotropy,
  sheen, translucency, colour variation with hex tones, and edge/seam behaviour. Material only: no scene,
  no object, no lighting setup.
- search_keywords: 8-15 lowercase terms covering material, finish, pattern, colour and style."""


CAPTION_USER_TEMPLATE = """Product code (context only): {product_id}
Measured dominant colours (CIELAB k-means on the illumination-normalised crop, share of pixels): {colors}
Return the JSON material profile."""


def format_dominant_colors(color_meta):
    if not color_meta:
        return "not measured"
    parts = []
    for hex_code, proportion in zip(color_meta.get("dominant_hex", []), color_meta.get("proportions", [])):
        parts.append(f"{hex_code} ({proportion * 100:.0f}%)")
    return ", ".join(parts) if parts else "not measured"


def compose_search_document(profile, dominant_hex=None):
    """The text that gets embedded: every field that helps a text query find this swatch."""
    secondary = ", ".join(profile.get("secondary_finishes") or [])
    keywords = ", ".join(profile.get("search_keywords") or [])
    lines = [
        f"Material: {profile.get('material_category')} - {profile.get('material_subtype')}",
        f"Finish: {profile.get('surface_finish')}" + (f" (also {secondary})" if secondary else ""),
        f"Grain / pattern: {profile.get('grain_or_pattern_description')}",
        f"Pattern scale: {profile.get('pattern_scale')}",
        f"Colour: {profile.get('color_palette_description')}",
        f"Specular: {profile.get('specular_behavior')}",
        f"Feel: {profile.get('micro_surface_feel')}",
        f"Keywords: {keywords}",
        f"Render description: {profile.get('nano_banana_render_prompt')}",
    ]
    if dominant_hex:
        lines.insert(5, "Measured colours: " + ", ".join(dominant_hex))
    return "\n".join(lines)
