// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Property Listings",
  description: "A persistent property listings site on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 60rem; margin: 2.5rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  a { color: inherit; }
  .filters { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; align-items: flex-end; }
  .filters .field { display: flex; flex-direction: column; gap: .25rem; }
  .filters label { font-size: .75rem; opacity: .7; }
  input, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; background: transparent; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; margin: 0; padding: 0; list-style: none; }
  .card { border: 1px solid #8883; border-radius: .75rem; padding: 1rem; display: flex; flex-direction: column; gap: .35rem; }
  .card h3 { margin: 0; }
  .card .price { font-weight: 600; font-size: 1.1rem; }
  .card .meta { opacity: .75; font-size: .85rem; }
  .card .desc { font-size: .9rem; opacity: .9; }
  .card.empty { opacity: .6; grid-column: 1 / -1; }
  .card .del { align-self: flex-start; margin-top: .25rem; }
  details.admin { margin: 2rem 0 1rem; border: 1px solid #8883; border-radius: .75rem; padding: .75rem 1rem; }
  details.admin summary { cursor: pointer; font-weight: 600; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin-top: 1rem; }
  .form-grid .full { grid-column: 1 / -1; }
  .form-grid textarea { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; background: transparent; min-height: 4rem; resize: vertical; }
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
