// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Open roles",
  description: "A persistent job board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 48rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
  input { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; flex: 1; min-width: 7rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .8rem 0; border-bottom: 1px solid #8883; display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  li.empty { opacity: .6; }
  .job-title { font-weight: 600; }
  .job-meta { opacity: .75; font-size: .9rem; }
  a { color: inherit; }
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
