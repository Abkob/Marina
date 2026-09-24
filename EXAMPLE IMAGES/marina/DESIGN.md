---
name: Marina
colors:
  surface: '#f8f9fa'
  surface-dim: '#d9dadb'
  surface-bright: '#f8f9fa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4f5'
  surface-container: '#edeeef'
  surface-container-high: '#e7e8e9'
  surface-container-highest: '#e1e3e4'
  on-surface: '#191c1d'
  on-surface-variant: '#444748'
  inverse-surface: '#2e3132'
  inverse-on-surface: '#f0f1f2'
  outline: '#747878'
  outline-variant: '#c4c7c7'
  surface-tint: '#5f5e5e'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#1c1b1b'
  on-primary-container: '#858383'
  inverse-primary: '#c8c6c5'
  secondary: '#4648d4'
  on-secondary: '#ffffff'
  secondary-container: '#6063ee'
  on-secondary-container: '#fffbff'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#2c0051'
  on-tertiary-container: '#ac59fb'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e5e2e1'
  primary-fixed-dim: '#c8c6c5'
  on-primary-fixed: '#1c1b1b'
  on-primary-fixed-variant: '#474746'
  secondary-fixed: '#e1e0ff'
  secondary-fixed-dim: '#c0c1ff'
  on-secondary-fixed: '#07006c'
  on-secondary-fixed-variant: '#2f2ebe'
  tertiary-fixed: '#f0dbff'
  tertiary-fixed-dim: '#ddb7ff'
  on-tertiary-fixed: '#2c0051'
  on-tertiary-fixed-variant: '#6900b3'
  background: '#f8f9fa'
  on-background: '#191c1d'
  surface-variant: '#e1e3e4'
  sidebar-bg: '#111827'
  canvas-bg: '#FFFFFF'
  ai-highlight-soft: '#EEF2FF'
  status-safe: '#10B981'
  status-warning: '#F59E0B'
  status-urgent: '#EF4444'
  status-blocked: '#6B7280'
typography:
  display-lg:
    fontFamily: Hanken Grotesk
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Hanken Grotesk
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Hanken Grotesk
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 30px
  body-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  canvas-margin: 64px
  gutter: 24px
  sidebar-width: 260px
  ai-rail-width: 320px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
---

## Brand & Style

The design system is built for a "Personal Operating System" that prioritizes mental clarity and effortless organization. The brand personality is **calm, smart, and direct**, acting as a supportive co-pilot rather than a demanding taskmaster. It targets high-performance individuals who require a tool that manages complexity without adding noise.

The design style is a blend of **Minimalism** and **Modern Corporate**, infused with **futuristic, high-fidelity accents**. It utilizes a "Document-First" philosophy, where the UI recedes to prioritize the user's thoughts, with AI structure appearing only when contextually relevant. The aesthetic is clean and professional—reminiscent of tools like Linear and Obsidian—emphasizing precision, speed, and reliability. 

Visual interest is generated through subtle motion, high-quality typography, and purposeful "AI highlights" that feel like a gentle glow rather than a distracting flash.

## Colors

The palette is intentionally restrained to maintain a calm environment. The interface relies on a **light mode** default for the main canvas to simulate the clarity of a physical document, contrasted by a **dark sidebar** (`#111827`) that houses the "machinery" of the OS.

**Primary & Secondary:** The primary color is a deep, near-black (`#1A1A1A`) used for text and core structural elements. The secondary and tertiary colors (`#6366F1` and `#A855F7`) are reserved for AI-driven highlights and "magical" moments, often appearing as soft gradients or subtle glows.

**Functional Colors:** Status indicators are the only areas where high chroma is permitted. These colors (Safe, Warning, Urgent) should be used sparingly as small pips, progress rings, or thin borders to signal health without overwhelming the user's focus.

## Typography

The typography system uses a tiered approach to balance character and utility.

1.  **Display & Headings:** **Hanken Grotesk** provides a sharp, contemporary feel that anchors the UI. It is used for page titles, goal names, and major dashboard headers.
2.  **Body (The Canvas):** **Inter** is the workhorse font, chosen for its exceptional readability in document-style environments. The line height for `body-lg` is intentionally generous (30px) to provide a "breathable" writing experience.
3.  **Utilities & Metadata:** **JetBrains Mono** is used for the "technical" layer. This includes confidence percentages, timestamps, deadline chips, and keyboard shortcuts. The monospaced nature signals to the user that this is data structured by the OS.

## Layout & Spacing

This design system uses a **fluid-to-fixed hybrid grid**. The central "Canvas" is the focal point, adhering to a max-width of 800px to ensure optimal line lengths for reading and writing, centered with generous `canvas-margin`.

-   **Desktop Layout:** A three-tier horizontal structure. The **Left Sidebar** is persistent and narrow. The **Center Canvas** is the primary workspace. The **Right AI Rail** is an optional, contextual layer that slides in to provide insights.
-   **Spacing Rhythm:** A strict 8px base unit is used. Content within cards uses `stack-sm` (8px), while sections on the dashboard use `stack-lg` (32px).
-   **Mobile Reflow:** On mobile, the sidebar and AI rail collapse into bottom-sheet menus. The canvas margins reduce to 16px, and the layout shifts to a single-column stack.

## Elevation & Depth

Hierarchy is established through **Tonal Layers** and **Ambient Shadows** rather than heavy borders.

-   **Level 0 (Base):** The Canvas background (`#FFFFFF`). No shadows.
-   **Level 1 (Cards):** Goal and Resource cards use a subtle, 1px neutral border (`#E5E7EB`) and a very soft, diffused shadow (10% opacity, 4px blur) to appear slightly lifted.
-   **Level 2 (AI Popups & Command Palette):** These elements use **Glassmorphism**. They feature a backdrop blur (12px) and a semi-transparent white background (80% opacity). They are anchored to specific text or cursor positions to feel like "overlays" on the thought process.
-   **Sidebars:** The sidebar uses color (Dark) rather than elevation to distinguish itself from the workspace.

## Shapes

The shape language is **Rounded**, conveying a supportive and modern approachable feel. 

-   **Cards & Containers:** Use a standard 0.5rem (8px) radius.
-   **Interactive Elements:** Buttons and Input fields follow the same 8px rule.
-   **AI Accents:** Progress rings and AI-suggested chips use pill-shapes (rounded-full) to distinguish "system-generated" elements from "user-generated" content.
-   **Selection States:** Hover states on list items should use a soft 4px (rounded-sm) corner to keep the list feeling compact.

## Components

### Buttons & Inputs
-   **Primary Action:** Solid `#1A1A1A` with white text.
-   **AI Action:** Ghost button with a subtle purple/blue border and a faint hover glow.
-   **Inputs:** Borderless on the canvas, with a subtle underline appearing only on focus.

### Progress Rings
Used for Goal health. They should be thin-stroked (2px) and use the `status` color palette. A dual-ring system represents **Activity** (inner ring) and **Finalization** (outer ring).

### Document-First Editor
The editor should appear entirely blank. Slash commands (`/`) trigger a clean list of components. AI-analyzed text is indicated by a very soft blue background highlight (`ai-highlight-soft`) that fades as the user continues typing.

### Compact AI Cards
These appear in the Right Rail or as anchored popups. They must include the "Logic Icon" (small info icon) which, when clicked, opens the **Explanation Drawer** to reveal the AI's reasoning.

### Resource Cards
Vertical stack: Type Icon (top-left), Title (bold), Metadata (monospaced bottom). Use a subtle hover lift to indicate interactivity.