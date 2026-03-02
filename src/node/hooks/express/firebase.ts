'use strict';

import {ArgsExpressType} from "../../types/ArgsExpressType";
import * as admin from "firebase-admin";
import express from "express";

// Initialize Firebase Admin
// If already initialized, don't do it again
if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: "adept-bastion-482216-k1"
  });
}

export const expressCreateServer = (hookName: string, {app}: ArgsExpressType, cb: Function) => {
  app.use(express.json());

  app.post('/api/auth/firebase-login', async (req: any, res: any) => {
    const { idToken } = req.body;

    if (!idToken) {
      console.warn('Firebase Login: Missing idToken');
      return res.status(400).json({ error: 'Missing idToken' });
    }

    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const { uid, email, name, picture } = decodedToken;

      console.info(`Firebase Login successful for user: ${email || uid}`);

      // Set user in session
      // @ts-ignore
      req.session.user = {
        username: email || uid,
        email: email,
        name: name,
        is_admin: false, // Default to false
        readOnly: false,
      };

      return res.json({ 
        success: true, 
        user: req.session.user 
      });
    } catch (error: any) {
      console.error('Error verifying Firebase ID token:', error.message);
      return res.status(401).json({ error: 'Invalid token' });
    }
  });

  return cb();
};
