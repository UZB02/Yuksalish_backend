import { z } from 'zod';

// Zod standart xabarlarini o'zbekchaga o'giradi (alohida xabar berilmagan holatlar uchun)
z.config({
  customError: (iss) => {
    switch (iss.code) {
      case 'invalid_type':
        return iss.input === undefined ? 'Majburiy maydon' : "Qiymat turi noto'g'ri";
      case 'too_small':
        return iss.origin === 'string'
          ? `Kamida ${iss.minimum} ta belgi bo'lishi kerak`
          : iss.origin === 'array'
            ? `Kamida ${iss.minimum} ta element bo'lishi kerak`
            : `Qiymat ${iss.minimum} dan kichik bo'lmasligi kerak`;
      case 'too_big':
        return iss.origin === 'string'
          ? `Ko'pi bilan ${iss.maximum} ta belgi bo'lishi mumkin`
          : iss.origin === 'array'
            ? `Ko'pi bilan ${iss.maximum} ta element bo'lishi mumkin`
            : `Qiymat ${iss.maximum} dan katta bo'lmasligi kerak`;
      case 'invalid_format':
        return "Format noto'g'ri";
      case 'invalid_value':
        return 'Ruxsat etilmagan qiymat';
      case 'unrecognized_keys':
        return "Noma'lum maydon yuborilgan";
      default:
        return undefined;
    }
  },
});
