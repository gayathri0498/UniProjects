// src/components/TNMap.js
import React from 'react';
import { MapContainer, TileLayer } from 'react-leaflet';

export default function TNMap() {
  return (
    <MapContainer
      center={[11.0, 78.0]}   // Center of Tamil Nadu
      zoom={7}
      style={{ height: '100vh', width: '100%' }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
      />
    </MapContainer>
  );
}