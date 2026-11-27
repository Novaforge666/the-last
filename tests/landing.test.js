"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "..", "landing.html"), "utf8");
const dom = new JSDOM(html, { url: "https://the-last-weld.vercel.app/landing.html" });
const doc = dom.window.document;
let passed = 0, failed = 0;
function check(name, value) {
  if (value) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name); }
}
const login = doc.getElementById("loginBtn"), signup = doc.getElementById("signupBtn");
check("sign-up is immediately next to the login button", !!login && login.nextElementSibling === signup);
check("login still opens the terminal OAuth entry point", login && login.getAttribute("href") === "/?app=1");
check("sign-up links directly to Deriv's official registration page", signup && signup.href === "https://home.deriv.com/dashboard/signup?lang=en");
check("external sign-up opens safely in a new tab", signup && signup.target === "_blank" && signup.relList.contains("noopener") && signup.relList.contains("noreferrer"));
check("visitors are told to return and log in after signing up", doc.querySelector(".hint").textContent.includes("return here to log in"));
check("guest terminal access is preserved", !!doc.querySelector('.cta a[href="/?app=1"]:not(#loginBtn)'));
console.log(`\n${passed} passed, ${failed} failed`);
dom.window.close();
process.exit(failed ? 1 : 0);
