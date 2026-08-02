function shouldUseRendererCapture(triggerId, usesSystemDefaultCapture) {
  return triggerId === "keyboard" && usesSystemDefaultCapture;
}

module.exports = { shouldUseRendererCapture };
