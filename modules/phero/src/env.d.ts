// Wrangler bundles *.html files as text modules (rules type="Text")
declare module '*.html' {
  const content: string;
  export default content;
}
