/** The documentation pages of site/site.json (the project overview). */
import { htmlHandler } from './pages.js';

export function mountDocs(app, ctx) {
  app.use(htmlHandler(ctx.root, ctx.site.table('docs'), 'npm run build:overview'));
}
