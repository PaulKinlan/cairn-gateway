import preview from "./main.ts";

Deno.serve((request) => preview.fetch(request));
