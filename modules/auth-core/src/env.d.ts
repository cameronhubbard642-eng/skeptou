// Module declaration for HTML template text imports (loaded via wrangler [[rules]])
declare module '*.html' {
  const content: string;
  export default content;
}
