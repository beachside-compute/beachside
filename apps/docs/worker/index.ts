// The docs site is static assets. The 1.0 beta page moved to beachsidecompute.com; this worker
// redirects the old /beta URL there (keeping the query string, so ad UTM tags survive) and hands
// every other request to the assets.

export type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
};

export const betaPage = "https://beachsidecompute.com/beta/";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/beta" || url.pathname === "/beta/")
      return Response.redirect(`${betaPage}${url.search}`, 301);

    return env.ASSETS.fetch(request);
  },
};
