# 🌐 Jarvis AI Core - SSL (HTTPS) आणि Nginx सेटअप मार्गदर्शिका

हा मार्गदर्शक तुम्हाला जार्विससाठी एक डोमेन नेम कनेक्ट करून ते **HTTPS (SSL)** वर सुरक्षितपणे चालवण्यास मदत करेल. यामुळे मोबाईल आणि डेस्कटॉपवर व्हॉईस इनपुट (Microphone) कोणतीही अडचण न येता काम करेल.

---

## 📋 पूर्वतयारी (Prerequisites)
1. **एक डोमेन नेम:** (उदा. `jarvis.yourdomain.com` किंवा `yourdomain.com`).
2. **DNS Pointing:** तुमच्या डोमेनच्या DNS settings मध्ये जाऊन एक **A Record** तयार करा जो तुमच्या VPS च्या IP कडे (`194.163.138.247`) पॉईंट करेल.

---

## 🛠️ स्टेप-बाय-स्टेप सेटअप

### स्टेप १: VPS वर Nginx इंस्टॉल करणे
टर्मिनलवर खालील कमांड्स चालवा:
```bash
sudo apt update
sudo apt install nginx -y
```

### स्टेप २: Nginx कॉन्फिगरेशन तयार करणे
जार्विससाठी नवीन Nginx कॉन्फिगरेशन फाईल उघडा:
```bash
sudo nano /etc/nginx/sites-available/jarvis
```

खालील कॉन्फिगरेशन कॉपी करून तिथे पेस्ट करा (तुमचे डोमेन नेम बदला):
```nginx
server {
    listen 80;
    server_name jarvis.yourdomain.com; # तुमचे डोमेन इथे टाका

    # Frontend (Next.js) Proxy
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Backend (Express API) Proxy
    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        
        # Connection timeouts (मोठ्या मॉडेल डाउनलोडसाठी)
        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
    }
}
```
*फाईल सेव्ह करण्यासाठी: `Ctrl+O` दाबा, मग `Enter` दाबा. बाहेर पडण्यासाठी `Ctrl+X` दाबा.*

### स्टेप ३: कॉन्फिगरेशन ॲक्टिव्हेट करणे
नवीन तयार केलेली फाईल ॲक्टिव्हेट करा आणि Nginx रिस्टार्ट करा:
```bash
# लिंक तयार करा
sudo ln -s /etc/nginx/sites-available/jarvis /etc/nginx/sites-enabled/

# Nginx कॉन्फिगरेशन तपासा (याने Syntax OK आला पाहिजे)
sudo nginx -t

# Nginx रिस्टार्ट करा
sudo systemctl restart nginx
```

---

### स्टेप ४: Certbot (SSL Certificate) इंस्टॉल करणे
**Let's Encrypt** कडून मोफत SSL घेण्यासाठी Certbot वापरू:
```bash
sudo apt install certbot python3-certbot-nginx -y
```

आता तुमच्या डोमेनसाठी SSL सर्टिफिकेट जनरेट करा:
```bash
sudo certbot --nginx -d jarvis.yourdomain.com
```
*(टीप: विचारल्यावर तुमचा ईमेल टाका आणि अटी मान्य करा. Certbot स्वतःच Nginx कॉन्फिगरेशनमध्ये SSL चे बदल करेल आणि HTTP ला स्वयंचलितपणे HTTPS वर रिडायरेक्ट करेल).*

---

### स्टेप ५: जार्विस कोडमध्ये डोमेन अपडेट करणे
आता जार्विसच्या फ्रंटएंडला तुमच्या नवीन डोमेनची माहिती देणे आवश्यक आहे जेणेकरून तो थेट HTTPS वरून बॅकएंडशी कनेक्ट होईल.

तुमच्या VPS वर `/root/jarvis-ai-core` मध्ये जा आणि `page.tsx` मधील IP पत्ता बदलून तुमचे नवीन डोमेन सेट करा:
```bash
cd /root/jarvis-ai-core
sed -i "s/194.163.138.247/jarvis.yourdomain.com/g" frontend/src/app/page.tsx
```

आता फ्रंटएंड डॉकर पुन्हा रिस्टार्ट करा:
```bash
docker-compose restart frontend
```

---

## 🎉 आता काय होईल?
* आता तुम्ही थेट **`https://jarvis.yourdomain.com`** वरून जार्विस वापरू शकता.
* SSL (HTTPS) मुळे **मोबाईल आणि डेस्कटॉप दोन्हीवर मायक्रोफोन (व्हॉईस चॅट)** पूर्णपणे सुरक्षितपणे काम करेल!
* या कॉन्फिगरेशनमुळे तुम्हाला बॅकएंडचा पोर्ट `8000` स्वतंत्रपणे उघडण्याची किंवा टाकायची गरज पडणार नाही. सर्व गोष्टी सुरक्षित डोमेनद्वारे चालतील.
