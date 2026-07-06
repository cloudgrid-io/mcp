// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Product Catalog",
  description: "A product catalog on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 60rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .filters { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
  .chip { padding: .35rem .8rem; border: 1px solid #8886; border-radius: 999px; background: none; font: inherit; cursor: pointer; }
  .chip.active { background: #6663; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
  .card { border: 1px solid #8883; border-radius: .75rem; padding: 1rem; display: flex; flex-direction: column; gap: .4rem; }
  .card h3 { margin: 0; }
  .card .cat { font-size: .8rem; opacity: .7; text-transform: uppercase; letter-spacing: .04em; }
  .card .price { font-size: 1.15rem; font-weight: 600; }
  .card .desc { font-size: .9rem; opacity: .85; margin: 0; }
  .card .foot { display: flex; align-items: center; justify-content: space-between; margin-top: auto; padding-top: .5rem; }
  .stock { font-size: .8rem; }
  .stock.in { color: #2a8a2a; }
  .stock.out { color: #b03535; }
  .empty { opacity: .6; grid-column: 1 / -1; }
  .admin { margin-top: 2.5rem; border-top: 1px solid #8883; padding-top: 1.5rem; }
  .admin h2 { font-size: 1.1rem; }
  .form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: .5rem; margin-bottom: .75rem; }
  input, select, textarea { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; width: 100%; background: none; color: inherit; }
  textarea { grid-column: 1 / -1; resize: vertical; min-height: 3rem; }
  label.check { display: flex; align-items: center; gap: .4rem; font-size: .9rem; }
  label.check input { width: auto; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .del { border-color: #b0353566; background: #b0353522; }
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
