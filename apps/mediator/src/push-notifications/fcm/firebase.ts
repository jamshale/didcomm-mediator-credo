import admin from 'firebase-admin'
import config from '../../config'

let firebaseApp: admin.app.App | undefined
if (!config.get('agent:usePushNotifications')) {
    firebaseApp = undefined
} else {
    firebaseApp = admin.apps.length
        ? admin.app()
        : admin.initializeApp({
            credential: admin.credential.cert({
                projectId: config.get('agent:firebase:projectId'),
                clientEmail: config.get('agent:firebase:clientEmail'),
                privateKey: config.get('agent:firebase:privateKey'),
            }),
        })
}


export const firebase = firebaseApp
