// Allow importing CSS files (side-effect imports for global stylesheets,
// and CSS Modules via Bun's bundler).
declare module "*.css" {
  const styles: Record<string, string>;
  export default styles;
}
