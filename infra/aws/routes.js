function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (
    uri === "/index.html" ||
    uri === "/preview-bridge.js" ||
    uri === "/LICENSE" ||
    uri === "/THIRD_PARTY_NOTICES.txt" ||
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
