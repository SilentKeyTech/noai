// Theme picker for the gateway pages. The choice is kept in this browser only.
(function () {
  var THEMES = [['auto', 'Match my device'], ['orange-dark', 'Orange, bold'], ['orange-light', 'Orange, light'], ['purple-dark', 'Purple, dark'], ['purple-light', 'Purple, light'], ['sky', 'Sky']];
  var KEY = 'noai_theme';
  function read() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function apply(t) { if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }
  apply(read());
  document.addEventListener('DOMContentLoaded', function () {
    var host = document.getElementById('themes');
    if (!host) return;
    host.className = 'gw-themes';
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Colour theme');
    function draw() {
      var cur = read();
      host.replaceChildren.apply(host, THEMES.map(function (t) {
        var b = document.createElement('button');
        b.type = 'button'; b.title = t[1]; b.setAttribute('aria-label', t[1]); b.setAttribute('aria-pressed', String(cur === t[0]));
        var s = document.createElement('span'); s.className = 'sw-' + t[0]; b.append(s);
        b.onclick = function () { try { localStorage.setItem(KEY, t[0]); } catch (e) {} apply(t[0]); draw(); };
        return b;
      }));
    }
    draw();
  });
})();
