// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Kanban board",
  description: "A persistent kanban board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 60rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .row { display: flex; gap: .5rem; margin-bottom: 1.5rem; }
  input { flex: 1; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; }
  button { padding: .4rem .7rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  .board section { border: 1px solid #8883; border-radius: .5rem; padding: .75rem; min-height: 6rem; }
  .board h2 { margin: 0 0 .5rem; font-size: .9rem; text-transform: uppercase; letter-spacing: .03em; opacity: .7; }
  .card { border: 1px solid #8886; border-radius: .5rem; padding: .5rem .6rem; margin-bottom: .5rem; }
  .card .title { display: block; margin-bottom: .4rem; }
  .moves { display: flex; flex-wrap: wrap; gap: .3rem; }
  .moves button { font-size: .8rem; }
  .empty { opacity: .6; font-size: .85rem; }
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
