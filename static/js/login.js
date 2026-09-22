(function () {
  "use strict";
  var form = document.getElementById("login-form");
  var btn = document.getElementById("login-btn");
  var err = document.getElementById("login-err");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    err.textContent = "";
    btn.disabled = true;
    fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("email").value,
        password: document.getElementById("password").value,
      }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
        return j;
      });
    }).then(function () {
      window.location.href = "/admin";
    }).catch(function (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      document.getElementById("password").value = "";
    });
  });
})();
