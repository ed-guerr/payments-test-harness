/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/renderer/**/*.tsx", "./src/renderer/**/*.html"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0e14",
        panel: "#11151f",
        edge: "#1e2532",
        pass: "#3fb950",
        fail: "#f85149",
        muted: "#7d8590",
        accent: "#58a6ff",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
