// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Projects",
  description: "A team project & task board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 60rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  h2 { margin: 2rem 0 .75rem; font-size: 1.15rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .row { display: flex; gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  input, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; background: transparent; }
  input { flex: 1; min-width: 8rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; padding: 0; margin: 0; }
  .projects li { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .6rem 0; border-bottom: 1px solid #8883; }
  .projects li.active { font-weight: 600; }
  .projects .name { cursor: pointer; flex: 1; }
  li.empty { opacity: .6; }
  .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  .col { border: 1px solid #8883; border-radius: .75rem; padding: .75rem; min-height: 6rem; }
  .col h3 { margin: 0 0 .5rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
  .card { border: 1px solid #8884; border-radius: .5rem; padding: .5rem .6rem; margin-bottom: .5rem; }
  .card .title { font-size: .95rem; }
  .card .assignee { font-size: .8rem; opacity: .65; }
  .card .actions { display: flex; gap: .35rem; margin-top: .4rem; flex-wrap: wrap; }
  .card .actions button { padding: .2rem .5rem; font-size: .75rem; }
  @media (max-width: 40rem) { .board { grid-template-columns: 1fr; } }
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
