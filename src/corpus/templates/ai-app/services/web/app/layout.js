// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "AI Assistant",
  description: "An AI chatbot on CloudGrid — grid AI gateway + grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .log { list-style: none; padding: 0; margin: 0 0 1rem; display: flex; flex-direction: column; gap: .75rem; }
  .log li { display: flex; flex-direction: column; gap: .15rem; }
  .log li.user { align-items: flex-end; text-align: right; }
  .log li.empty { opacity: .6; align-items: flex-start; }
  .who { font-size: .75rem; opacity: .6; }
  .msg { display: inline-block; padding: .5rem .75rem; border-radius: .6rem; background: #8882; max-width: 85%; white-space: pre-wrap; }
  .log li.user .msg { background: #4a90d922; }
  .row { display: flex; gap: .5rem; }
  input { flex: 1; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
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
