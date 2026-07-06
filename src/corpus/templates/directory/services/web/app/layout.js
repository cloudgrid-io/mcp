// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Directory",
  description: "A searchable directory of listings on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  form.add { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-bottom: 1.5rem; }
  form.add input { grid-column: span 1; }
  form.add textarea { grid-column: span 2; }
  form.add .actions { grid-column: span 2; display: flex; justify-content: flex-end; }
  .filters { display: flex; gap: .5rem; margin-bottom: 1rem; }
  input, textarea, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; background: transparent; }
  textarea { resize: vertical; min-height: 3rem; }
  .filters input { flex: 1; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: .8rem 0; border-bottom: 1px solid #8883; }
  li.empty { opacity: .6; justify-content: flex-start; }
  .entry-main { min-width: 0; }
  .entry-head { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
  .entry-name { font-weight: 600; }
  .cat { font-size: .75rem; padding: .1rem .5rem; border: 1px solid #8886; border-radius: 1rem; opacity: .8; }
  .entry-url { font-size: .85rem; word-break: break-all; }
  .entry-desc { margin: .25rem 0 0; opacity: .8; font-size: .9rem; }
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
