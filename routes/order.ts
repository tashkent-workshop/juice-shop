/*
 * Copyright (c) 2014-2025 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs'
import path from 'node:path'
import config from 'config'
import PDFDocument from 'pdfkit'
import { type Request, type Response, type NextFunction } from 'express'

import { challenges, products } from '../data/datacache'
import * as challengeUtils from '../lib/challengeUtils'
import { BasketItemModel } from '../models/basketitem'
import { DeliveryModel } from '../models/delivery'
import { QuantityModel } from '../models/quantity'
import { ProductModel } from '../models/product'
import { BasketModel } from '../models/basket'
import { WalletModel } from '../models/wallet'
import * as security from '../lib/insecurity'
import * as utils from '../lib/utils'
import * as db from '../data/mongodb'

interface Product {
  quantity: number
  id?: number
  name: string
  price: number
  total: number
  bonus: number
}

interface DeliveryMethod {
  deluxePrice: number
  price: number
  eta: number
}

export function placeOrder () {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id
    BasketModel.findOne({ where: { id }, include: [{ model: ProductModel, paranoid: false, as: 'Products' }] })
      .then(async (basket: BasketModel | null) => {
        if (basket == null) {
          next(new Error(`Basket with id=${id} does not exist.`))
          return
        }

        const customer = security.authenticatedUsers.from(req)
        const email = customer?.data?.email ?? ''
        const orderId = security.hash(email).slice(0, 4) + '-' + utils.randomHexString(16)
        const date = new Date().toJSON().slice(0, 10)

        const { basketProducts, itemsTotal, totalPoints } = await processBasketItems(basket, req)

        const discount = calculateApplicableDiscount(basket, req) ?? 0
        const discountAmount = discount > 0 ? (itemsTotal * (discount / 100)).toFixed(2) : '0'
        const priceAfterDiscount = itemsTotal - parseFloat(discountAmount)

        const deliveryMethod = await resolveDeliveryMethod(req)
        const deliveryAmount = security.isDeluxe(req) ? deliveryMethod.deluxePrice : deliveryMethod.price
        const totalPrice = priceAfterDiscount + deliveryAmount

        challengeUtils.solveIf(challenges.negativeOrderChallenge, () => { return totalPrice < 0 })

        if (req.body.UserId) {
          settleWalletPayment(req, totalPrice, totalPoints, next)
        }

        const pdfFile = `order_${orderId}.pdf`
        const doc = new PDFDocument()
        const fileWriter = doc.pipe(fs.createWriteStream(path.join('ftp/', pdfFile)))

        fileWriter.on('finish', async () => {
          void basket.update({ coupon: null })
          await BasketItemModel.destroy({ where: { BasketId: id } })
          res.json({ orderConfirmation: orderId })
        })

        renderOrderPdf(doc, {
          req,
          email,
          orderId,
          date,
          basketProducts,
          discount,
          discountAmount,
          deliveryAmount,
          totalPrice,
          totalPoints
        })

        await db.ordersCollection.insert({
          promotionalAmount: discountAmount,
          paymentId: req.body.orderDetails ? req.body.orderDetails.paymentId : null,
          addressId: req.body.orderDetails ? req.body.orderDetails.addressId : null,
          orderId,
          delivered: false,
          email: (email ? email.replace(/[aeiou]/gi, '*') : undefined),
          totalPrice,
          products: basketProducts,
          bonus: totalPoints,
          deliveryPrice: deliveryAmount,
          eta: deliveryMethod.eta.toString()
        })
        doc.end()
      }).catch((error: unknown) => {
        next(error)
      })
  }
}

async function processBasketItems (basket: BasketModel, req: Request): Promise<{ basketProducts: Product[], itemsTotal: number, totalPoints: number }> {
  const items = basket.Products ?? []

  const processedItems = await Promise.all(items.map(async ({ BasketItem, price, deluxePrice, name, id }) => {
    if (BasketItem == null) {
      return null
    }

    challengeUtils.solveIf(challenges.christmasSpecialChallenge, () => { return BasketItem.ProductId === products.christmasSpecial.id })

    await updateProductStock(BasketItem.ProductId, BasketItem.quantity)

    const itemPrice = security.isDeluxe(req) ? deluxePrice : price
    const itemTotal = itemPrice * BasketItem.quantity
    const itemBonus = Math.round(itemPrice / 10) * BasketItem.quantity

    const product: Product = {
      quantity: BasketItem.quantity,
      id,
      name: req.__(name),
      price: itemPrice,
      total: itemTotal,
      bonus: itemBonus
    }

    return { product, itemTotal, itemBonus }
  }))

  const basketProducts: Product[] = []
  let itemsTotal = 0
  let totalPoints = 0
  for (const entry of processedItems) {
    if (entry == null) {
      continue
    }
    basketProducts.push(entry.product)
    itemsTotal += entry.itemTotal
    totalPoints += entry.itemBonus
  }

  return { basketProducts, itemsTotal, totalPoints }
}

async function updateProductStock (productId: number, orderedQuantity: number) {
  const product = await QuantityModel.findOne({ where: { ProductId: productId } })
  if (product == null) {
    return
  }
  const newQuantity = product.quantity - orderedQuantity
  await QuantityModel.update({ quantity: newQuantity }, { where: { ProductId: productId } })
}

async function resolveDeliveryMethod (req: Request): Promise<DeliveryMethod> {
  const deliveryMethod: DeliveryMethod = {
    deluxePrice: 0,
    price: 0,
    eta: 5
  }
  const deliveryMethodId = req.body.orderDetails?.deliveryMethodId
  if (!deliveryMethodId) {
    return deliveryMethod
  }
  const deliveryMethodFromModel = await DeliveryModel.findOne({ where: { id: deliveryMethodId } })
  if (deliveryMethodFromModel != null) {
    deliveryMethod.deluxePrice = deliveryMethodFromModel.deluxePrice
    deliveryMethod.price = deliveryMethodFromModel.price
    deliveryMethod.eta = deliveryMethodFromModel.eta
  }
  return deliveryMethod
}

function settleWalletPayment (req: Request, totalPrice: number, totalPoints: number, next: NextFunction) {
  if (req.body.orderDetails && req.body.orderDetails.paymentId === 'wallet') {
    WalletModel.findOne({ where: { UserId: req.body.UserId } }).then((wallet) => {
      if ((wallet != null) && wallet.balance >= totalPrice) {
        WalletModel.decrement({ balance: totalPrice }, { where: { UserId: req.body.UserId } }).catch((error: unknown) => {
          next(error)
        })
      } else {
        next(new Error('Insufficient wallet balance.'))
      }
    }).catch((error: unknown) => {
      next(error)
    })
  }
  WalletModel.increment({ balance: totalPoints }, { where: { UserId: req.body.UserId } }).catch((error: unknown) => {
    next(error)
  })
}

function renderOrderPdf (doc: PDFKit.PDFDocument, params: {
  req: Request
  email: string
  orderId: string
  date: string
  basketProducts: Product[]
  discount: number
  discountAmount: string
  deliveryAmount: number
  totalPrice: number
  totalPoints: number
}) {
  const { req, email, orderId, date, basketProducts, discount, discountAmount, deliveryAmount, totalPrice, totalPoints } = params

  doc.font('Times-Roman').fontSize(40).text(config.get<string>('application.name'), { align: 'center' })
  doc.moveTo(70, 115).lineTo(540, 115).stroke()
  doc.moveTo(70, 120).lineTo(540, 120).stroke()
  doc.fontSize(20).moveDown()
  doc.font('Times-Roman').fontSize(20).text(req.__('Order Confirmation'), { align: 'center' })
  doc.fontSize(20).moveDown()
  doc.font('Times-Roman').fontSize(15).text(`${req.__('Customer')}: ${email}`, { align: 'left' })
  doc.font('Times-Roman').fontSize(15).text(`${req.__('Order')} #: ${orderId}`, { align: 'left' })
  doc.moveDown()
  doc.font('Times-Roman').fontSize(15).text(`${req.__('Date')}: ${date}`, { align: 'left' })
  doc.moveDown()
  doc.moveDown()

  for (const product of basketProducts) {
    doc.text(`${product.quantity}x ${product.name} ${req.__('ea.')} ${product.price} = ${product.total}¤`)
    doc.moveDown()
  }
  doc.moveDown()

  if (discount > 0) {
    doc.text(discount + '% discount from coupon: -' + discountAmount + '¤')
    doc.moveDown()
  }

  doc.text(`${req.__('Delivery Price')}: ${deliveryAmount.toFixed(2)}¤`)
  doc.moveDown()
  doc.font('Helvetica-Bold').fontSize(20).text(`${req.__('Total Price')}: ${totalPrice.toFixed(2)}¤`)
  doc.moveDown()
  doc.font('Helvetica-Bold').fontSize(15).text(`${req.__('Bonus Points Earned')}: ${totalPoints}`)
  doc.font('Times-Roman').fontSize(15).text(`(${req.__('The bonus points from this order will be added 1:1 to your wallet ¤-fund for future purchases!')}`)
  doc.moveDown()
  doc.moveDown()
  doc.font('Times-Roman').fontSize(15).text(req.__('Thank you for your order!'))
}

function calculateApplicableDiscount (basket: BasketModel, req: Request) {
  if (security.discountFromCoupon(basket.coupon ?? undefined)) {
    const discount = security.discountFromCoupon(basket.coupon ?? undefined)
    challengeUtils.solveIf(challenges.forgedCouponChallenge, () => { return (discount ?? 0) >= 80 })
    console.log(discount)
    return discount
  } else if (req.body.couponData) {
    const couponData = Buffer.from(req.body.couponData, 'base64').toString().split('-')
    const couponCode = couponData[0]
    const couponDate = Number(couponData[1])
    const campaign = campaigns[couponCode as keyof typeof campaigns]

    if (campaign && couponDate == campaign.validOn) { // eslint-disable-line eqeqeq
      challengeUtils.solveIf(challenges.manipulateClockChallenge, () => { return campaign.validOn < new Date().getTime() })
      return campaign.discount
    }
  }
  return 0
}

const campaigns = {
  WMNSDY2019: { validOn: new Date('Mar 08, 2019 00:00:00 GMT+0100').getTime(), discount: 75 },
  WMNSDY2020: { validOn: new Date('Mar 08, 2020 00:00:00 GMT+0100').getTime(), discount: 60 },
  WMNSDY2021: { validOn: new Date('Mar 08, 2021 00:00:00 GMT+0100').getTime(), discount: 60 },
  WMNSDY2022: { validOn: new Date('Mar 08, 2022 00:00:00 GMT+0100').getTime(), discount: 60 },
  WMNSDY2023: { validOn: new Date('Mar 08, 2023 00:00:00 GMT+0100').getTime(), discount: 60 },
  ORANGE2020: { validOn: new Date('May 04, 2020 00:00:00 GMT+0100').getTime(), discount: 50 },
  ORANGE2021: { validOn: new Date('May 04, 2021 00:00:00 GMT+0100').getTime(), discount: 40 },
  ORANGE2022: { validOn: new Date('May 04, 2022 00:00:00 GMT+0100').getTime(), discount: 40 },
  ORANGE2023: { validOn: new Date('May 04, 2023 00:00:00 GMT+0100').getTime(), discount: 40 }
}
