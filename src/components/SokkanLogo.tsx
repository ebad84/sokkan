import { useState } from 'react';
import sokkanLogoImg from '../assets/images/sokkan_logo_1795713602488.jpg';

interface SokkanLogoProps {
  size?: number;
  className?: string;
}

export function SokkanLogo({ size = 32, className = '' }: SokkanLogoProps) {
  const [imgFailed, setImgFailed] = useState(false);

  if (imgFailed) {
    return (
      <img
        src="/sokkan-logo.svg"
        alt="لوگوی سکان"
        width={size}
        height={size}
        className={`rounded-lg shrink-0 ${className}`}
      />
    );
  }

  return (
    <img
      src={sokkanLogoImg}
      alt="لوگوی سکان"
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      onError={() => setImgFailed(true)}
      className={`rounded-lg object-cover border border-[#1F2937] shrink-0 ${className}`}
    />
  );
}
