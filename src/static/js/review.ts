'use strict';

/**
 * Review page: sets baseURL and back-to-pad link. The list of large additions
 * is server-rendered in the template (data from handleReviewPage).
 */

let baseURL = '';

const init = () => {
  const pathComponents = window.location.pathname.split('/');
  const padPath = pathComponents.slice(0, 3).join('/');
  const backLink = document.getElementById('review-back-to-pad');
  if (backLink) {
    (backLink as HTMLAnchorElement).href = padPath;
  }
};

exports.baseURL = baseURL;
exports.init = init;
