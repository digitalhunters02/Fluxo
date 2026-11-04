// Kept as a separate file because the app's Content-Security-Policy does not allow inline scripts.
(function () {
  var L = (navigator.language || "en").slice(0, 2);
  var T = {
    pt: ["Você está offline", "O Fluxo precisa de conexão com a internet. Verifique sua conexão e tente de novo.", "Tentar de novo"],
    es: ["Estás sin conexión", "Fluxo necesita conexión a internet. Revisa tu conexión e inténtalo de nuevo.", "Reintentar"],
  }[L];
  if (T) {
    document.documentElement.lang = L;
    document.getElementById("t").textContent = T[0];
    document.getElementById("m").textContent = T[1];
    document.getElementById("b").textContent = T[2];
  }
  document.getElementById("b").addEventListener("click", function () { location.reload(); });
})();
