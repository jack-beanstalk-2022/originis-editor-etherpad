// @license magnet:?xt=urn:btih:8e4f440f4c65981c5bf93c76d35135ba5064d8b7&dn=apache-2.0.txt
(function () {
  const pathComponents = location.pathname.split('/');
  // Path is /p/:pad/review -> baseURL is site root, pad is pathComponents[2]
  const baseURL = pathComponents.slice(0, 3).join('/') + '/';
  const review = require('ep_etherpad-lite/static/js/review');
  review.baseURL = baseURL;
  review.init();
})();
