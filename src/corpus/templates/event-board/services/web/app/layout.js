// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Event Board",
  description: "A community event board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  form { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-bottom: 2rem; }
  form .full { grid-column: 1 / -1; }
  input, textarea { width: 100%; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; }
  textarea { min-height: 3.5rem; resize: vertical; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .8rem 0; border-bottom: 1px solid #8883; }
  li.empty { opacity: .6; }
  .event-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
  .event-title { font-weight: 600; }
  .event-meta { font-size: .85rem; opacity: .75; margin: .15rem 0; }
  .event-desc { margin: .35rem 0 0; opacity: .9; }
  .del { padding: .25rem .6rem; font-size: .8rem; }
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
