# Rein, design system

One page, `web/index.html`, no build step. Everything below is in its
`<style>` block as custom properties.

## Colour, committed

| token | value | role |
|---|---|---|
| `--bg` | oklch(0.985 0 0) | page ground, chroma zero on purpose |
| `--ink` | oklch(0.21 0.012 60) | text, primary buttons, the v2 section ground |
| `--ink-2` | oklch(0.40 0.012 60) | body copy on light ground (about 7:1) |
| `--brand` | oklch(0.70 0.20 45) | hazard orange: the hero ground, the tape, the numbered steps, the refusal codes |
| `--brand-deep` | oklch(0.50 0.16 40) | the only orange allowed as text on white |
| `--ok` | oklch(0.52 0.14 150) | reserved for the one allowed payment |
| `--term-*` | dark ink and tinted greys | the on-chain transcript, the product's own artefact |

The orange is a boundary, not a highlight. It is the hero ground, the two
striped tapes, and the refusal marks; it is never a gradient and never text
on white at full chroma.

## Type

- Bricolage Grotesque, optical sizing on, 400 to 800. One family, contrast by
  weight and size. Display ceiling 5.6rem, tracking floor -0.03em.
- JetBrains Mono for the transcript, addresses, policy keys and codes,
  because those are real terminal and chain artefacts.
- Body 17px / 1.55. Prose capped at 60 to 66ch.

## Motifs

- **The tape.** A 14px repeating diagonal of orange and ink, once under the
  hero and once above the footer. Nowhere else.
- **The transcript.** The dark panel with the real run typing itself in. It
  is the imagery. Two instances: abridged in the hero, full in Proof.
- **Numbered steps** only in How it works, because that is a real sequence.
- **Spec list** (`dl`) for what the chain enforces, mono keys, prose values.

## Motion

- Hero entrance: five children rise 14px over 0.7s, staggered 80ms, expo out.
- Transcript lines fade and lift 3px, timed by line kind. Starts on load in
  the hero, on intersection in Proof. Replay button on both.
- `prefers-reduced-motion`: no entrance, transcript renders complete.

## Bans honoured

No eyebrows over sections, no gradient text, no glass, no side-stripe
borders, no metric cards, no testimonials, no logos, no fake forms. The
early-access call to action is a mailto because there is no backend.
