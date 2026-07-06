// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Task manager",
  description: "A persistent task manager on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  input, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; }
  input[type="text"] { flex: 1; min-width: 10rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .filters { display: flex; gap: .4rem; margin-bottom: 1rem; }
  .filters button.active { background: #6669; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: .6rem; padding: .6rem 0; border-bottom: 1px solid #8883; }
  li.done .title { text-decoration: line-through; opacity: .6; }
  li .title { flex: 1; }
  li .meta { font-size: .8rem; opacity: .7; }
  .pri { font-size: .75rem; padding: .1rem .45rem; border: 1px solid #8886; border-radius: 1rem; }
  .empty { opacity: .6; }
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
