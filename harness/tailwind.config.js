/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/renderer/**/*.tsx", "./src/renderer/**/*.html"],
  theme: {
    extend: {
      // All colors are CSS variables (RGB triplets, set per theme in
      // index.css under [data-theme]), so opacity modifiers like
      // `bg-accent/20` keep working and the palette switches at runtime.
      colors: {
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        panel: "rgb(var(--c-panel) / <alpha-value>)",
        edge: "rgb(var(--c-edge) / <alpha-value>)",
        fg: "rgb(var(--c-fg) / <alpha-value>)",
        dim: "rgb(var(--c-dim) / <alpha-value>)",
        faint: "rgb(var(--c-faint) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        pass: "rgb(var(--c-pass) / <alpha-value>)",
        fail: "rgb(var(--c-fail) / <alpha-value>)",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
