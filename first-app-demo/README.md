# First App Demo

A minimal Even Hub G2 app based on the official "Your First App" walkthrough.

## Run

```powershell
npm install
npm run dev
```

Open the Vite URL in the simulator:

```powershell
npm run simulator -- http://localhost:5173
```

Or run the simulator command directly if Vite chooses a different port:

```powershell
npx evenhub-simulator http://localhost:5174
```

For hardware sideloading, replace the host with your computer's LAN IP:

```powershell
npx evenhub qr --url "http://192.168.1.100:5173"
```

## Build And Pack

```powershell
npm run build
npm run pack
```
