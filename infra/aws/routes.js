function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri === "/_control" || uri.indexOf("/_control/") === 0) {
    return {
      statusCode: 404,
      statusDescription: "Not Found",
      headers: { "cache-control": { value: "no-store" } },
    };
  }

  if (
    uri === "/index.html" ||
    uri === "/preview-bridge.js" ||
    uri.indexOf("/assets/") === 0 ||
    uri === "/_indexes" ||
    uri.indexOf("/_indexes/") === 0 ||
    uri === "/_artifacts" ||
    uri.indexOf("/_artifacts/") === 0 ||
    uri === "/_previews" ||
    uri.indexOf("/_previews/") === 0 ||
    uri === "/_errors" ||
    uri.indexOf("/_errors/") === 0
  ) {
    return request;
  }

  request.uri = "/index.html";
  return request;
}
