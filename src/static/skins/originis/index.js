'use strict';

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      window.customStart();
    } else {
      window.addEventListener('DOMContentLoaded', window.customStart, {once: true});
    }
  }
});

function setupAuthDialogs() {
  const signupDialog = document.getElementById('signup-dialog');
  const signupOpenBtn = document.getElementById('signup-open-btn');
  const signupCloseBtn = document.getElementById('signup-close-btn');
  const signupForm = document.getElementById('signup-form');
  const loginDialog = document.getElementById('login-dialog');
  const loginBtn = document.getElementById('login-btn');
  const loginCloseBtn = document.getElementById('login-close-btn');
  const loginForm = document.getElementById('login-form');
  if (signupOpenBtn && signupDialog) {
    signupOpenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      signupDialog.showModal();
    });
  }
  if (signupCloseBtn && signupDialog) {
    signupCloseBtn.addEventListener('click', () => signupDialog.close());
  }
  if (signupDialog) {
    signupDialog.addEventListener('click', (e) => {
      if (e.target === signupDialog) signupDialog.close();
    });
  }
  if (loginBtn && loginDialog) {
    loginBtn.addEventListener('click', () => loginDialog.showModal());
  }
  if (loginCloseBtn && loginDialog) {
    loginCloseBtn.addEventListener('click', () => loginDialog.close());
  }
  if (loginDialog) {
    loginDialog.addEventListener('click', (e) => {
      if (e.target === loginDialog) loginDialog.close();
    });
  }

  function showError(dialogEl, message) {
    if (!dialogEl) return;
    let errEl = dialogEl.querySelector('.auth-error');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.className = 'auth-error';
      errEl.style.color = '#c00';
      errEl.style.marginTop = '8px';
      errEl.style.fontSize = '13px';
      dialogEl.querySelector('form')?.appendChild(errEl);
    }
    errEl.textContent = message;
    errEl.style.display = 'block';
  }

  function clearError(dialogEl) {
    const errEl = dialogEl?.querySelector('.auth-error');
    if (errEl) errEl.style.display = 'none';
  }

  async function syncSessionWithBackend(idToken) {
    const res = await fetch('/api/auth/firebase-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      credentials: 'include'
    });
    const data = res.ok ? await res.json().catch(() => ({})) : null;
    if (!res.ok) {
      const err = (data && data.error) || res.statusText || 'Login failed';
      throw new Error(err);
    }
    return data;
  }

  if (signupForm && typeof firebase !== 'undefined') {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError(signupDialog);
      const passwordEl = document.getElementById('signup-password');
      const confirmEl = document.getElementById('signup-password-confirm');
      const emailEl = document.getElementById('signup-email');
      if (passwordEl && confirmEl && passwordEl.value !== confirmEl.value) {
        confirmEl.setCustomValidity('Passwords do not match');
        confirmEl.reportValidity();
        return;
      }
      if (confirmEl) confirmEl.setCustomValidity('');
      const email = emailEl?.value?.trim();
      const password = passwordEl?.value;
      if (!email || !password) return;
      const submitBtn = signupForm.querySelector('.signup-submit');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Signing up…';
      }
      try {
        const config = window.FIREBASE_CONFIG || {};
        if (!config.apiKey || config.apiKey === 'YOUR_API_KEY') {
          showError(signupDialog, 'Firebase is not configured. Set FIREBASE_CONFIG in the page.');
          return;
        }
        if (!firebase.apps.length) firebase.initializeApp(config);
        const userCred = await firebase.auth().createUserWithEmailAndPassword(email, password);
        const idToken = await userCred.user.getIdToken();
        await syncSessionWithBackend(idToken);
        signupDialog.close();
        window.location.reload();
      } catch (err) {
        showError(signupDialog, err.message || 'Sign up failed');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Sign up';
        }
      }
    });
  }

  if (loginForm && typeof firebase !== 'undefined') {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearError(loginDialog);
      const emailEl = document.getElementById('login-email');
      const passwordEl = document.getElementById('login-password');
      const email = emailEl?.value?.trim();
      const password = passwordEl?.value;
      if (!email || !password) return;
      const submitBtn = loginForm.querySelector('.login-submit');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Logging in…';
      }
      try {
        const config = window.FIREBASE_CONFIG || {};
        if (!config.apiKey || config.apiKey === 'YOUR_API_KEY') {
          showError(loginDialog, 'Firebase is not configured. Set FIREBASE_CONFIG in the page.');
          return;
        }
        if (!firebase.apps.length) firebase.initializeApp(config);
        const userCred = await firebase.auth().signInWithEmailAndPassword(email, password);
        const idToken = await userCred.user.getIdToken();
        await syncSessionWithBackend(idToken);
        loginDialog.close();
        window.location.reload();
      } catch (err) {
        showError(loginDialog, err.message || 'Log in failed');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Log in';
        }
      }
    });
  }
}

function updateNavAuthState(user) {
  const authButtons = document.getElementById('nav-auth-buttons');
  const userSection = document.getElementById('nav-user-section');
  const userEmailEl = document.getElementById('nav-user-email');
  const padDatalist = document.querySelector('.pad-datalist');
  const createPadWrapper = document.getElementById('wrapper');
  if (!authButtons || !userSection || !userEmailEl) return;
  if (user && user.email) {
    authButtons.style.display = 'none';
    userEmailEl.textContent = user.email;
    userEmailEl.title = user.email;
    userSection.style.display = 'flex';
    if (padDatalist) padDatalist.style.display = 'block';
    if (createPadWrapper) createPadWrapper.style.display = '';
  } else {
    authButtons.style.display = 'flex';
    userSection.style.display = 'none';
    userEmailEl.textContent = '';
    userEmailEl.title = '';
    if (padDatalist) padDatalist.style.display = 'none';
    if (createPadWrapper) createPadWrapper.style.display = 'none';
  }
}

function setupAuthStateListener() {
  if (typeof firebase === 'undefined') return;
  const config = window.FIREBASE_CONFIG || {};
  if (!config.apiKey || config.apiKey === 'YOUR_API_KEY') return;
  if (!firebase.apps.length) firebase.initializeApp(config);
  firebase.auth().onAuthStateChanged((user) => {
    updateNavAuthState(user);
  });
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await firebase.auth().signOut();
        window.location.reload();
      } catch (err) {
        console.error('Logout failed:', err);
        window.location.reload();
      }
    });
  }
}

window.customStart = () => {
  setupAuthDialogs();
  setupAuthStateListener();
  // Hide Recent Pads and create-pad section until auth state is known; show only when logged in (see updateNavAuthState)
  const padDatalist = document.querySelector('.pad-datalist');
  if (padDatalist) padDatalist.style.display = 'none';
  const createPadWrapper = document.getElementById('wrapper');
  if (createPadWrapper) createPadWrapper.style.display = 'none';
  const recentPadList = document.getElementById('recent-pads');
  if (recentPadList) {
    recentPadList.replaceChildren();
  }
  // define your javascript here
  // jquery is available - except index.js
  // you can load extra scripts with $.getScript http://api.jquery.com/jQuery.getScript/
  const recentPadListHeading = document.getElementById('recent-pads-heading');
  const recentPadsFromLocalStorage = localStorage.getItem('recentPads');
  let recentPadListData = [];
  if (recentPadsFromLocalStorage != null) {
    recentPadListData = JSON.parse(recentPadsFromLocalStorage);
  }

  // Remove duplicates based on pad name and sort by timestamp
  recentPadListData = recentPadListData.filter(
      (pad, index, self) => index === self.findIndex((p) => p.name === pad.name)
  ).sort((a, b) => new Date(a.timestamp) > new Date(b.timestamp) ? -1 : 1);

  if (recentPadList && recentPadListData.length === 0 && recentPadListHeading) {
    const parentStyle = recentPadList.parentElement.style;
    recentPadListHeading.textContent = 'No recent doc found.';
    parentStyle.display = 'flex';
    parentStyle.justifyContent = 'center';
    parentStyle.alignItems = 'center';
    parentStyle.maxHeight = '100%';
    recentPadList.remove();
  } else if (recentPadList) {
    /**
     * @typedef {Object} Pad
     * @property {string} name
     */

    /**
     * @param {Pad} pad
     */

    const arrowIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right w-4 h-4 text-gray-400"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>';
    const clockIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock w-3 h-3"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
    const personalIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users w-3 h-3"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>';
    recentPadListData.forEach((pad) => {
      const li = document.createElement('li');


      li.style.cursor = 'pointer';

      li.className = 'recent-pad';
      const padPath = `${window.location.href}p/${pad.name}`;
      const link = document.createElement('a');
      link.style.textDecoration = 'none';

      link.href = padPath;
      link.innerText = pad.name;
      li.appendChild(link);


      const arrowIconElement = document.createElement('span');
      arrowIconElement.className = 'recent-pad-arrow';
      arrowIconElement.innerHTML = arrowIcon;
      li.appendChild(arrowIconElement);

      const nextRow = document.createElement('div');

      nextRow.style.display = 'flex';
      nextRow.style.gap = '10px';
      nextRow.style.marginTop = '10px';

      const clockIconElement = document.createElement('span');
      clockIconElement.className = 'recent-pad-clock';
      clockIconElement.innerHTML = clockIcon;

      nextRow.appendChild(clockIconElement);

      const time = new Date(pad.timestamp);
      const userLocale = navigator.language || 'en-US';

      const formattedTime = time.toLocaleDateString(userLocale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const timeElement = document.createElement('span');
      timeElement.className = 'recent-pad-time';
      timeElement.innerText = formattedTime;

      nextRow.appendChild(timeElement);

      const personalIconElement = document.createElement('span');
      personalIconElement.className = 'recent-pad-personal';
      personalIconElement.innerHTML = personalIcon;

      personalIconElement.style.marginLeft = '5px';

      const members = document.createElement('span');
      members.className = 'recent-pad-members';
      members.innerText = pad.members;


      nextRow.appendChild(personalIconElement);
      nextRow.appendChild(members);
      li.appendChild(nextRow);

      li.addEventListener('click', () => {
        window.location.href = padPath;
      });

      // https://v0.dev/chat/etherpad-design-clone-qZnwOrVRXxH
      recentPadList.appendChild(li);
    });
  }
};
